import SwiftUI

struct WorkflowListView: View {
    @Environment(CompanionStore.self) private var store
    @State private var showCreate = false
    @State private var showAsk = false
    @State private var showArchived = false

    private var visibleWorkflows: [Workflow] {
        store.workflows.filter { showArchived || !$0.archived }
    }

    var body: some View {
        List {
            ConnectionStatusSection()
            if !store.conflicts.isEmpty {
                Section {
                    NavigationLink {
                        ConflictListView()
                    } label: {
                        Label("Resolve \(store.conflicts.count) pending conflicts", systemImage: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
                    }
                    .accessibilityIdentifier("workflows.conflicts")
                }
            }
            Section("Your workflows") {
                if visibleWorkflows.isEmpty {
                    ContentUnavailableView("No workflows", systemImage: "list.bullet.rectangle", description: Text("Create a workflow, or ask Umpi to create one. No examples are added to your data."))
                }
                ForEach(visibleWorkflows) { workflow in
                    NavigationLink {
                        WorkflowDetailView(workflowID: workflow.id)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(workflow.definition.title)
                            if workflow.archived { Text("Archived").font(.caption).foregroundStyle(.secondary) }
                            if !store.draftValues(for: workflow.id).isEmpty {
                                Text("Local draft").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("workflow.row.\(workflow.id)")
                }
            }
            if !store.orphanedWorkflowDrafts.isEmpty {
                Section {
                    ForEach(store.orphanedWorkflowDrafts) { draft in
                        NavigationLink {
                            MissingWorkflowDraftView(workflowID: draft.id)
                        } label: {
                            Label("Draft for \(draft.id)", systemImage: "square.and.pencil")
                        }
                        .accessibilityIdentifier("workflow.missingDraft.\(draft.id)")
                    }
                } header: {
                    Text("Drafts for missing workflows")
                } footer: {
                    Text("These workflows are no longer in the coordinator snapshot. Your local input is retained for review, not silently recreated.")
                }
            }
            if store.workflows.contains(where: \.archived) {
                Toggle("Show archived workflows", isOn: $showArchived)
            }
        }
        .navigationTitle("Workflows")
        .refreshable { await store.synchronize() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Ask Umpi", systemImage: "bubble.left") { showAsk = true }
                    .accessibilityIdentifier("workflows.ask")
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Create workflow", systemImage: "plus") { showCreate = true }
                    .accessibilityIdentifier("workflows.create")
            }
        }
        .sheet(isPresented: $showCreate) { CreateWorkflowView() }
        .sheet(isPresented: $showAsk) { AskUmpiView() }
    }
}

private struct MissingWorkflowDraftView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let workflowID: String
    @State private var confirmDiscard = false

    var body: some View {
        Form {
            Section("Missing workflow") {
                Text(workflowID).textSelection(.enabled)
                Text("This workflow is no longer present in the coordinator snapshot. These unsaved values remain on this device. They cannot be automatically applied to a removed workflow.")
            }
            if let draft = store.orphanedWorkflowDrafts.first(where: { $0.id == workflowID }) {
                Section("Preserved local input") {
                    ForEach(draft.values.keys.sorted(), id: \.self) { fieldID in
                        VStack(alignment: .leading) {
                            Text(fieldID).font(.caption).textSelection(.enabled)
                            Text(draft.values[fieldID]?.stringValue ?? "").textSelection(.enabled)
                        }
                    }
                }
                Section {
                    Button("Discard this local draft", role: .destructive) { confirmDiscard = true }
                        .accessibilityIdentifier("workflow.missingDraft.discard")
                }
            }
        }
        .navigationTitle("Preserved draft")
        .confirmationDialog("Discard all local input for this missing workflow?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard local draft", role: .destructive) {
                store.discardWorkflowDraft(id: workflowID)
                dismiss()
            }
        } message: {
            Text("Copy any input you want to keep first. This only removes the local draft; it does not recreate or change coordinator data.")
        }
    }
}

struct WorkflowDetailView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let workflowID: String
    @State private var confirmRemove = false
    @State private var confirmArchive = false
    @State private var saving = false
    @State private var orphanToDiscard: String?

    var body: some View {
        Group {
            if let workflow = store.workflow(id: workflowID) {
                Form {
                    if let description = workflow.definition.description, !description.isEmpty {
                        Section { Text(description) }
                    }
                    Section("Fields") {
                        if workflow.definition.fields.isEmpty { Text("This workflow has no fields.").foregroundStyle(.secondary) }
                        ForEach(workflow.definition.fields) { field in
                            WorkflowFieldView(workflowID: workflowID, field: field)
                                .disabled(workflow.archived)
                        }
                    }
                    if !store.draftValues(for: workflowID).isEmpty {
                        Section {
                            Label("Local edits are preserved across refreshes.", systemImage: "square.and.pencil")
                            Button(saving ? "Saving…" : "Save changes") {
                                saving = true
                                Task {
                                    await store.saveDraft(workflowID: workflowID)
                                    saving = false
                                }
                            }
                            .disabled(saving || workflow.archived)
                            .accessibilityIdentifier("workflow.save")
                        }
                    }
                    orphanedSection
                    if !workflow.definition.actions.isEmpty {
                        Section {
                            ForEach(workflow.definition.actions) { action in
                                Button(action.title) {
                                    Task { await store.runButton(workflowID: workflowID, buttonID: action.id) }
                                }
                                .disabled(workflow.archived)
                                .accessibilityIdentifier("workflow.action.\(action.id)")
                            }
                        } header: {
                            Text("Workflow actions")
                        } footer: {
                            Text("These actions come from the workflow definition. They cannot approve commands or grant device permissions.")
                        }
                    }
                    ForEach(store.runs.filter { $0.workflowID == workflowID }) { run in
                        Section(run.title) {
                            LabeledContent("Status", value: run.status)
                            Text("\(run.nextStep) of \(run.steps.count) steps completed")
                            if let error = run.error { Text(error).foregroundStyle(.secondary) }
                            if run.status != "completed" && run.status != "cancelled" {
                                Button("Resume action") { Task { await store.resumeRun(id: run.id) } }
                                Button("Stop action", role: .destructive) { store.cancelRun(id: run.id) }
                                Text("Stopping does not reverse completed steps.").font(.footnote)
                            }
                        }
                    }
                    if store.conflicts.contains(where: { $0.workflowID == workflowID }) {
                        Section {
                            NavigationLink("Review conflicting changes") { ConflictListView(workflowID: workflowID) }
                        }
                    }
                    ConnectionStatusSection()
                    Section("Manage workflow") {
                        LabeledContent("Revision", value: String(workflow.revision))
                        if workflow.archived {
                            Button("Restore workflow") { Task { await store.restoreWorkflow(id: workflowID) } }
                        } else {
                            Button("Archive workflow") { confirmArchive = true }
                        }
                        Button("Remove workflow", role: .destructive) { confirmRemove = true }
                    }
                }
                .navigationTitle(workflow.definition.title)
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.synchronize() }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.synchronize() } }
                            .disabled(store.isRefreshing)
                            .accessibilityIdentifier("workflow.refresh")
                    }
                }
            } else {
                ContentUnavailableView("Workflow unavailable", systemImage: "questionmark.folder", description: Text("The workflow may have been removed. Other workflows and local pending changes are not affected."))
            }
        }
        .confirmationDialog("Remove this workflow?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove workflow", role: .destructive) {
                Task { await store.removeWorkflow(id: workflowID); if store.workflow(id: workflowID) == nil { dismiss() } }
            }
        } message: { Text("This explicitly removes the workflow from the coordinator. Review any unsaved edits before continuing.") }
        .confirmationDialog("Archive this workflow?", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("Archive workflow") { Task { await store.archiveWorkflow(id: workflowID) } }
        } message: { Text("The workflow and its values are retained. You can restore it later.") }
        .confirmationDialog("Discard this local draft?", isPresented: Binding(get: { orphanToDiscard != nil }, set: { if !$0 { orphanToDiscard = nil } }), titleVisibility: .visible) {
            Button("Discard local draft", role: .destructive) {
                if let fieldID = orphanToDiscard { store.discardDraft(workflowID: workflowID, fieldID: fieldID) }
                orphanToDiscard = nil
            }
        } message: { Text("This removes only the unsaved draft for the removed field. Saved coordinator values are unchanged.") }
    }

    @ViewBuilder private var orphanedSection: some View {
        let orphans = store.orphanedDrafts(for: workflowID)
        if !orphans.isEmpty {
            Section {
                ForEach(orphans.keys.sorted(), id: \.self) { fieldID in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(fieldID).font(.caption).textSelection(.enabled)
                        Text(orphans[fieldID]?.stringValue ?? "").textSelection(.enabled)
                        Button("Restore field to form") {
                            guard var definition = store.workflow(id: workflowID)?.definition else { return }
                            definition.fields.append(FieldDefinition(id: fieldID, label: fieldID, kind: "text"))
                            Task { await store.updateDefinition(workflowID: workflowID, definition: definition) }
                        }
                        Button("Discard local draft", role: .destructive) { orphanToDiscard = fieldID }
                    }
                }
            } header: { Text("Drafts from removed fields") } footer: {
                Text("A definition change removed these fields from the form, but your input is still here. Restore a field to edit it, or explicitly discard its local draft.")
            }
        }
    }
}

struct WorkflowFieldView: View {
    @Environment(CompanionStore.self) private var store
    let workflowID: String
    let field: FieldDefinition

    private var value: FieldValue { store.displayedValues(for: workflowID)[field.id] ?? .null }
    private func set(_ value: FieldValue) { store.setDraft(workflowID: workflowID, fieldID: field.id, value: value) }
    private var text: Binding<String> { Binding(get: { value.stringValue }, set: { set(.string($0)) }) }
    private static let timestamp = ISO8601DateFormatter()
    private static let fractionalTimestamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private var dateValue: Date? {
        Self.fractionalTimestamp.date(from: value.stringValue) ?? Self.timestamp.date(from: value.stringValue)
    }

    var body: some View {
        Group {
            switch field.kind {
            case "text":
                TextField(field.label, text: text)
            case "multiline":
                VStack(alignment: .leading) {
                    Text(field.label).font(.subheadline)
                    TextField(field.label, text: text, axis: .vertical).lineLimit(3...12)
                }
            case "toggle":
                Toggle(field.label, isOn: Binding(get: { value.boolValue }, set: { set(.bool($0)) }))
            case "number":
                TextField(field.label, value: Binding<Double?>(get: { value.numberValue }, set: { set($0.map(FieldValue.number) ?? .null) }), format: .number)
                    .keyboardType(.numbersAndPunctuation)
            case "date":
                if let date = dateValue {
                    DatePicker(field.label, selection: Binding(get: { date }, set: { set(.string(Self.timestamp.string(from: $0))) }))
                    Button("Clear \(field.label)") { set(.null) }
                } else {
                    if !value.stringValue.isEmpty {
                        Text("Existing value: \(value.stringValue)").textSelection(.enabled)
                        Text("Choose a date to replace this value.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Set \(field.label)") { set(.string(Self.timestamp.string(from: Date()))) }
                }
            case "choice":
                Picker(field.label, selection: Binding(get: { value.stringValue }, set: { set($0.isEmpty ? .null : .string($0)) })) {
                    Text("Not selected").tag("")
                    if !value.stringValue.isEmpty && !(field.options ?? []).contains(where: { $0.id == value.stringValue }) {
                        Text("Previous value: \(value.stringValue)").tag(value.stringValue)
                    }
                    ForEach(field.options ?? []) { option in Text(option.label).tag(option.id) }
                }
            default:
                Label("Unsupported field: \(field.label)", systemImage: "exclamationmark.triangle")
            }
        }
        .accessibilityIdentifier("workflow.field.\(field.id)")
        .accessibilityLabel(field.label)
    }
}

struct ConflictListView: View {
    @Environment(CompanionStore.self) private var store
    var workflowID: String?

    var body: some View {
        List {
            ForEach(store.conflicts.filter { workflowID == nil || $0.workflowID == workflowID }) { conflict in
                Section(store.workflow(id: conflict.workflowID)?.definition.title ?? conflict.workflowID) {
                    Text(conflict.message)
                    LabeledContent("Change", value: conflict.kind)
                    if let current = conflict.current { LabeledContent("Server revision", value: String(current.revision)) }
                    ForEach(conflict.localValues.keys.sorted(), id: \.self) { key in
                        VStack(alignment: .leading) {
                            Text(key).font(.headline)
                            Text("Local: \(conflict.localValues[key]?.stringValue ?? "Cleared")").textSelection(.enabled)
                            Text("Server: \(conflict.current?.values[key]?.stringValue ?? "Not set")").textSelection(.enabled).foregroundStyle(.secondary)
                        }
                    }
                    Button("Keep local change using latest revision") {
                        Task { await store.resolveConflict(id: conflict.id, keepLocal: true) }
                    }
                    .accessibilityIdentifier("conflict.keep.\(conflict.id)")
                    Button("Use server version", role: .destructive) {
                        Task { await store.resolveConflict(id: conflict.id, keepLocal: false) }
                    }
                    .accessibilityIdentifier("conflict.server.\(conflict.id)")
                }
            }
            if store.conflicts.isEmpty { ContentUnavailableView("No pending conflicts", systemImage: "checkmark.circle") }
        }
        .navigationTitle("Resolve changes")
        .refreshable { await store.refresh() }
    }
}

private struct NewWorkflowField: Identifiable {
    let id = UUID().uuidString
    var label = ""
    var kind = "text"
}

struct CreateWorkflowView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var fields = [NewWorkflowField()]
    @State private var creating = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Workflow") {
                    TextField("Title", text: $title).accessibilityIdentifier("create.title")
                }
                Section {
                    ForEach($fields) { $field in
                        VStack(alignment: .leading) {
                            TextField("Field label", text: $field.label).accessibilityIdentifier("create.field.label")
                            Picker("Type", selection: $field.kind) {
                                Text("Text").tag("text")
                                Text("Long text").tag("multiline")
                                Text("Number").tag("number")
                                Text("Toggle").tag("toggle")
                                Text("Date and time").tag("date")
                            }
                        }
                    }
                    .onDelete { fields.remove(atOffsets: $0) }
                    Button("Add field", systemImage: "plus") { fields.append(NewWorkflowField()) }
                        .disabled(fields.count >= 32)
                } header: { Text("Fields") } footer: {
                    Text("Choose the fields you need. Swipe to remove a field before creating. You can ask Umpi to add choices or workflow actions later without replacing saved values.")
                }
                if let error = store.errorMessage { Section { Text(error) } }
            }
            .disabled(creating)
            .navigationTitle("Create workflow")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "Creating…" : "Create") {
                        creating = true
                        Task {
                            store.clearError()
                            let accepted = await store.createWorkflow(title: title.trimmingCharacters(in: .whitespacesAndNewlines), fields: fields.map { FieldDefinition(id: $0.id, label: $0.label.trimmingCharacters(in: .whitespacesAndNewlines), kind: $0.kind) })
                            creating = false
                            if accepted { dismiss() }
                        }
                    }
                    .disabled(creating || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || fields.contains { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                    .accessibilityIdentifier("create.submit")
                }
            }
            .interactiveDismissDisabled(creating)
        }
    }
}
