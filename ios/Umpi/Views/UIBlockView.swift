import Charts
import SwiftUI

/// Any JSON value. A UI block is drawn straight from the tree the coordinator checked (`src/worker/ui-spec.ts` is
/// the format's source), so the app has no model type for each component, and a coordinator that learns a new
/// component or property cannot break an older build: what this build does not know, it does not draw.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// The properties of a component, or of one entry in a component's list (a row, an item, a tab, a point).
struct UIProps: Equatable, Sendable {
    let values: [String: JSONValue]

    init?(_ value: JSONValue) {
        guard case .object(let values) = value else { return nil }
        self.values = values
    }

    /// A component's type; nil for a list entry.
    var type: String? { text("type") }
    /// Text, or a number written as the owner would read it.
    func text(_ key: String) -> String? {
        switch values[key] {
        case .string(let value)?: value.isEmpty ? nil : value
        case .number(let value)?: value.formatted(.number.precision(.fractionLength(0...4)))
        default: nil
        }
    }
    func flag(_ key: String) -> Bool { values[key] == .bool(true) }
    func number(_ key: String) -> Double? { if case .number(let value)? = values[key] { value } else { nil } }
    /// The entries of a list property: child components, items, rows of a key-value list, tabs, series, points.
    func list(_ key: String) -> [UIProps] {
        guard case .array(let entries)? = values[key] else { return [] }
        return entries.compactMap(UIProps.init)
    }
    var children: [UIProps] { list("children") }
    /// Table rows: lists of cell text.
    func rows(_ key: String) -> [[String]] {
        guard case .array(let rows)? = values[key] else { return [] }
        return rows.map { row in
            guard case .array(let cells) = row else { return [] }
            return cells.map { if case .string(let cell) = $0 { cell } else { "" } }
        }
    }
    var tone: Color? { text("tone").flatMap(UITone.color) }
}

enum UITone {
    /// The colour of a tone name; nil for a name this build does not know, so the default colour stays.
    static func color(_ name: String) -> Color? {
        switch name {
        case "neutral": .primary
        case "accent": .accentColor
        case "positive": .green
        case "warning": .orange
        case "critical": .red
        case "muted": .secondary
        default: nil
        }
    }
}

extension EnvironmentValues {
    /// Sends text as the owner's next message, for a UI block's send button. Nil where a block cannot send (a preview).
    @Entry var uiSend: (@MainActor @Sendable (String) -> Void)? = nil
}

/// One UI block under a reply, drawn with native components.
struct UIBlockView: View {
    let block: JSONValue

    var body: some View {
        if let root = UIProps(block), root.type != nil {
            UIComponent(node: root)
                // A block keeps a readable measure in a wide Mac window instead of stretching across it.
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
        }
    }
}

/// Draws one component and, through its children, the tree below it. A type this build does not know draws nothing.
struct UIComponent: View {
    let node: UIProps

    var body: some View {
        switch node.type {
        case "stack": stack
        case "grid": grid
        case "card": card
        case "section": UISection(node: node)
        case "tabs": UITabs(node: node)
        case "disclosure": DisclosureGroup(node.text("title") ?? "") { UIChildren(nodes: node.children).padding(.top, 6) }
        case "divider": Divider()
        case "text": text
        case "markdown": MarkdownView(node.text("text") ?? "")
        case "icon": icon(node.text("name") ?? "", size: node.text("size")).foregroundStyle(node.tone ?? .primary)
        case "badge": badge
        case "stat": stat
        case "keyvalue": keyvalue
        case "list": UIList(node: node)
        case "table": table
        case "progress": progress
        case "timeline": timeline
        case "chart": UIChart(node: node)
        case "button": UIButton(node: node)
        case "link": link
        default: EmptyView()
        }
    }

    /// Components that have a natural size of their own, as opposed to text and containers, which fill the width.
    static let compact: Set<String> = ["button", "badge", "link", "icon"]

    private func spacing(_ name: String?) -> CGFloat {
        switch name {
        case "none": 0
        case "small": 6
        case "large": 18
        default: 10
        }
    }

    @ViewBuilder private var stack: some View {
        let gap = spacing(node.text("gap"))
        if node.text("direction") == "horizontal" {
            if node.children.allSatisfy({ UIComponent.compact.contains($0.type ?? "") }) {
                // Buttons, badges, links, and icons keep their own size and wrap onto more lines as whole items, so a
                // long label never squeezes its neighbour or breaks mid-phrase beside it.
                UIFlow(spacing: max(gap, 6), alignment: node.text("align")) { UIChildren.each(node.children) }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                let alignment: VerticalAlignment = switch node.text("align") { case "start": .top; case "end": .bottom; default: .firstTextBaseline }
                HStack(alignment: alignment, spacing: gap) {
                    ForEach(Array(node.children.enumerated()), id: \.offset) { _, child in
                        // An icon or a badge keeps its size; text takes the rest of the line and wraps there.
                        if child.type == "icon" || child.type == "badge" { UIComponent(node: child).fixedSize() } else { UIComponent(node: child) }
                    }
                }
            }
        } else {
            let alignment: HorizontalAlignment = switch node.text("align") { case "center": .center; case "end": .trailing; default: .leading }
            VStack(alignment: alignment, spacing: gap) { UIChildren.each(node.children) }
                .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment, vertical: .center))
        }
    }

    private var grid: some View {
        UIColumns(count: min(max(Int(node.number("columns") ?? 2), 2), 4)) { UIChildren.each(node.children) }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            if node.text("title") != nil || node.text("subtitle") != nil || node.text("icon") != nil {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let name = node.text("icon") { icon(name, size: "medium").foregroundStyle(node.tone ?? .accentColor) }
                    VStack(alignment: .leading, spacing: 1) {
                        if let title = node.text("title") { Text(title).font(.headline).lineLimit(2) }
                        if let subtitle = node.text("subtitle") { Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                    }
                }
            }
            UIChildren(nodes: node.children)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var text: some View {
        let font: Font = switch node.text("style") {
        case "title": .title3.weight(.semibold)
        case "headline": .headline
        case "caption": .caption
        case "mono": .callout.monospaced()
        default: .body
        }
        let alignment: TextAlignment = switch node.text("align") { case "center": .center; case "end": .trailing; default: .leading }
        let frame: Alignment = switch node.text("align") { case "center": .center; case "end": .trailing; default: .leading }
        return Text(node.text("text") ?? "").font(font).foregroundStyle(node.tone ?? (node.text("style") == "caption" ? .secondary : .primary))
            .multilineTextAlignment(alignment).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: frame)
    }

    private func icon(_ name: String, size: String?) -> some View {
        let font: Font = switch size { case "small": .footnote; case "large": .title; default: .body }
        return Image(systemName: name).font(font).accessibilityHidden(true)
    }

    private var badge: some View {
        let tone = node.tone ?? .secondary
        return Text(node.text("label") ?? "").font(.caption.weight(.semibold)).foregroundStyle(tone)
            .padding(.horizontal, 9).padding(.vertical, 4).background(tone.opacity(0.14), in: Capsule())
    }

    private var stat: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(node.text("label") ?? "").font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(node.text("value") ?? "").font(.title2.weight(.semibold)).foregroundStyle(node.tone ?? .primary).lineLimit(1).minimumScaleFactor(0.6)
                if let delta = node.text("delta") { Text(delta).font(.footnote.weight(.medium)).foregroundStyle(delta.hasPrefix("-") || delta.hasPrefix("−") ? Color.red : Color.green) }
            }
            if let detail = node.text("detail") { Text(detail).font(.caption).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var keyvalue: some View {
        VStack(spacing: 7) {
            ForEach(Array(node.list("rows").enumerated()), id: \.offset) { _, row in
                let label = Text(row.text("label") ?? "").foregroundStyle(.secondary)
                let value = Text(row.text("value") ?? "").foregroundStyle(row.tone ?? .primary)
                // Side by side when both fit on one line; a long value goes under its label instead of wrapping in a narrow column.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) { label.lineLimit(1).fixedSize(); Spacer(minLength: 8); value.lineLimit(1).fixedSize() }
                    VStack(alignment: .leading, spacing: 1) { label.font(.caption); value.fixedSize(horizontal: false, vertical: true) }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var table: some View {
        let columns = node.list("columns"), rows = node.rows("rows")
        func alignment(_ column: UIProps?) -> HorizontalAlignment { switch column?.text("align") { case "center": .center; case "end": .trailing; default: .leading } }
        let grid = Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
            GridRow {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    Text(column.text("title") ?? "").font(.caption.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1).fixedSize().gridColumnAlignment(alignment(column))
                }
            }
            Divider()
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                        Text(cell).font(.subheadline).monospacedDigit().lineLimit(1).fixedSize().gridColumnAlignment(alignment(index < columns.count ? columns[index] : nil))
                    }
                }
            }
        }
        // A wide table scrolls on its own, so the conversation never scrolls sideways.
        return ViewThatFits(in: .horizontal) { grid; ScrollView(.horizontal, showsIndicators: false) { grid } }
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 4) {
            if node.text("label") != nil || node.text("detail") != nil {
                HStack { Text(node.text("label") ?? ""); Spacer(minLength: 8); Text(node.text("detail") ?? "").foregroundStyle(.secondary) }.font(.subheadline)
            }
            // Drawn, not a system control, so it looks the same on iPhone and Mac and in a rendered image.
            let value = min(max(node.number("value") ?? 0, 0), 1)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.2))
                    Capsule().fill(node.tone ?? .accentColor).frame(width: max(proxy.size.width * value, value > 0 ? 6 : 0))
                }
            }
            .frame(height: 6)
            .accessibilityElement().accessibilityLabel(node.text("label") ?? "Progress").accessibilityValue(value.formatted(.percent.precision(.fractionLength(0))))
        }
    }

    private var timeline: some View {
        let items = node.list("items")
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                let state = item.text("state")
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 0) {
                        Image(systemName: state == "done" ? "checkmark.circle.fill" : state == "current" ? "circle.inset.filled" : "circle")
                            .font(.footnote).foregroundStyle(state == "upcoming" ? Color.secondary : Color.accentColor).frame(height: 18)
                        if index < items.count - 1 { Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 1.5).frame(maxHeight: .infinity) }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        if let time = item.text("time") { Text(time).font(.caption).foregroundStyle(.secondary) }
                        Text(item.text("title") ?? "").font(.subheadline.weight(state == "current" ? .semibold : .regular))
                        if let detail = item.text("detail") { Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    }
                    .padding(.bottom, index < items.count - 1 ? 12 : 0)
                }
                // As tall as its text, so the line under the mark reaches the next item. Without a height of its own
                // the row gives the line only a shape's default 10 points.
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var link: some View {
        if let address = node.text("url"), let url = URL(string: address) {
            Link(destination: url) { Label(node.text("label") ?? address, systemImage: "arrow.up.right").font(.subheadline) }
        }
    }
}

/// Lays items out in rows at their own size and starts a new row when the next item does not fit: whole items wrap,
/// never the words inside one beside its neighbours. An item wider than the row gets the row to itself and wraps inside.
struct UIFlow: Layout {
    var spacing: CGFloat = 8
    var alignment: String?

    private struct Row { var items: [(index: Int, size: CGSize)] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = [Row()]
        for (index, subview) in subviews.enumerated() {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            let needed = rows[rows.count - 1].items.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width, !rows[rows.count - 1].items.isEmpty { rows.append(Row()) }
            let last = rows.count - 1
            rows[last].width = rows[last].items.isEmpty ? size.width : rows[last].width + spacing + size.width
            rows[last].height = max(rows[last].height, size.height)
            rows[last].items.append((index, size))
        }
        return rows.filter { !$0.items.isEmpty }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX + (alignment == "center" ? (bounds.width - row.width) / 2 : alignment == "end" ? bounds.width - row.width : 0)
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y + (row.height - item.size.height) / 2), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }
}

/// Equal columns: as many as asked for, fewer when a cell would be narrower than `minimum`, so three stats sit side
/// by side on a wide screen and step down to two or one on a narrow one instead of squeezing their text.
struct UIColumns: Layout {
    var count: Int
    var minimum: CGFloat = 104
    var spacing: CGFloat = 12

    private func columns(_ width: CGFloat) -> Int {
        guard width.isFinite else { return count }
        return max(1, min(count, Int((width + spacing) / (minimum + spacing))))
    }
    private func cell(_ width: CGFloat) -> CGFloat {
        let columns = CGFloat(columns(width))
        return width.isFinite ? (width - spacing * (columns - 1)) / columns : minimum
    }
    private func heights(_ subviews: Subviews, width: CGFloat) -> [CGFloat] {
        let columns = columns(width), cell = cell(width)
        return stride(from: 0, to: subviews.count, by: columns).map { start in
            subviews[start..<min(start + columns, subviews.count)].map { $0.sizeThatFits(ProposedViewSize(width: cell, height: nil)).height }.max() ?? 0
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity, heights = heights(subviews, width: width)
        let natural = cell(width) * CGFloat(columns(width)) + spacing * CGFloat(columns(width) - 1)
        return CGSize(width: width.isFinite ? width : natural, height: heights.reduce(0, +) + spacing * CGFloat(max(heights.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let columns = columns(bounds.width), cell = cell(bounds.width), heights = heights(subviews, width: bounds.width)
        var y = bounds.minY
        for (row, height) in heights.enumerated() {
            for column in 0..<columns where row * columns + column < subviews.count {
                subviews[row * columns + column].place(at: CGPoint(x: bounds.minX + CGFloat(column) * (cell + spacing), y: y), proposal: ProposedViewSize(width: cell, height: height))
            }
            y += height + spacing
        }
    }
}

/// A column of child components with the usual gap.
struct UIChildren: View {
    let nodes: [UIProps]
    var body: some View { VStack(alignment: .leading, spacing: 10) { UIChildren.each(nodes) }.frame(maxWidth: .infinity, alignment: .leading) }
    static func each(_ nodes: [UIProps]) -> some View {
        ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in UIComponent(node: node) }
    }
}

private struct UISection: View {
    let node: UIProps
    @State private var folded: Bool?

    var body: some View {
        let collapsible = node.flag("collapsible"), closed = folded ?? (collapsible && node.flag("collapsed"))
        VStack(alignment: .leading, spacing: 8) {
            if collapsible {
                Button { withAnimation(.snappy(duration: 0.2)) { folded = !closed } } label: {
                    HStack { Text(node.text("title") ?? "").font(.headline); Spacer(); Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).rotationEffect(.degrees(closed ? 0 : 90)) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Text(node.text("title") ?? "").font(.headline)
            }
            if !closed { UIChildren(nodes: node.children) }
        }
    }
}

private struct UITabs: View {
    let node: UIProps
    @State private var selected = 0

    var body: some View {
        let tabs = node.list("tabs")
        VStack(alignment: .leading, spacing: 10) {
            // Drawn, not a system segmented control, so it looks the same on iPhone and Mac and in a rendered image.
            HStack(spacing: 3) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                    Button { withAnimation(.snappy(duration: 0.15)) { selected = index } } label: {
                        Text(tab.text("label") ?? "").font(.subheadline.weight(selected == index ? .semibold : .regular)).lineLimit(1)
                            .padding(.vertical, 6).frame(maxWidth: .infinity)
                            .background(selected == index ? Color(.systemBackground) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected == index ? .isSelected : [])
                }
            }
            .padding(3)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if tabs.indices.contains(selected) { UIChildren(nodes: tabs[selected].children) }
        }
    }
}

/// Rows with a title and optional detail. A checklist's ticks are the owner's own marks in this view: they change
/// nothing on the coordinator and are gone when the view is.
private struct UIList: View {
    let node: UIProps
    @State private var ticks: [Int: Bool] = [:]

    var body: some View {
        let items = node.list("items"), style = node.text("style")
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                let ticked = ticks[index] ?? item.flag("checked")
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    if style == "checklist" {
                        Button { ticks[index] = !ticked } label: {
                            Image(systemName: ticked ? "checkmark.circle.fill" : "circle").foregroundStyle(ticked ? Color.accentColor : Color.secondary)
                        }
                        .buttonStyle(.plain).accessibilityLabel(ticked ? "Ticked" : "Not ticked")
                    } else if style == "numbered" {
                        Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
                    } else if let name = item.text("icon") {
                        Image(systemName: name).foregroundStyle(item.tone ?? .accentColor).accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.text("title") ?? "").strikethrough(style == "checklist" && ticked, color: .secondary).foregroundStyle(style == "checklist" && ticked ? .secondary : (item.tone ?? .primary))
                        if let detail = item.text("detail") { Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    }
                    Spacer(minLength: 8)
                    if let trailing = item.text("trailing") { Text(trailing).font(.subheadline).foregroundStyle(.secondary).monospacedDigit() }
                }
                .font(.subheadline)
            }
        }
    }
}

private struct UIChart: View {
    let node: UIProps
    private struct Point: Identifiable { let id: Int; let series: String; let x: String; let y: Double }

    var body: some View {
        let series = node.list("series"), kind = node.text("kind"), unit = node.text("unit") ?? "Value"
        let points = series.enumerated().flatMap { index, entry in
            entry.list("points").enumerated().compactMap { offset, point -> Point? in
                guard let x = point.text("x"), let y = point.number("y") else { return nil }
                return Point(id: index * 1_000 + offset, series: entry.text("name") ?? "", x: x, y: y)
            }
        }
        VStack(alignment: .leading, spacing: 6) {
            if let title = node.text("title") { Text(title).font(.subheadline.weight(.semibold)) }
            Chart(points) { point in
                switch kind {
                case "line": LineMark(x: .value("", point.x), y: .value(unit, point.y)).foregroundStyle(by: .value("Series", point.series))
                case "area": AreaMark(x: .value("", point.x), y: .value(unit, point.y)).foregroundStyle(by: .value("Series", point.series)).opacity(0.7)
                default: BarMark(x: .value("", point.x), y: .value(unit, point.y)).foregroundStyle(by: .value("Series", point.series)).position(by: .value("Series", point.series))
                }
            }
            // A line shows change, so its scale follows the values; bars and areas show amounts and start at zero.
            .chartYScale(domain: .automatic(includesZero: kind != "line"))
            .chartLegend(series.count > 1 ? .visible : .hidden)
            .frame(height: 180)
        }
    }
}

private struct UIButton: View {
    let node: UIProps
    @Environment(\.uiSend) private var send
    @Environment(\.openURL) private var openURL
    @State private var done = false

    var body: some View {
        let label = node.text("label") ?? "", action = node.text("action"), style = node.text("style")
        let button = Button(role: style == "destructive" ? .destructive : nil) {
            switch action {
            case "send": send?(label); done = true
            case "open": if let address = node.text("url"), let url = URL(string: address) { openURL(url) }
            case "copy": if let text = node.text("text") { copy(text); done = true }
            default: break
            }
        } label: {
            // A choice is its words alone, like a quick reply. Open and copy keep a small sign of what the tap does.
            HStack(spacing: 5) {
                if action == "open" { Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)) }
                if action == "copy" { Image(systemName: done ? "checkmark" : "doc.on.doc").font(.caption.weight(.semibold)) }
                Text(action == "copy" && done ? "Copied" : label).lineLimit(2).multilineTextAlignment(.center)
            }
            .font(.subheadline.weight(.medium))
        }
        .buttonBorderShape(.capsule)
        // A sent choice stays sent: a second tap would say it twice.
        .disabled(action == "send" && (send == nil || done))
        if style == "primary" { button.buttonStyle(.borderedProminent) } else { button.buttonStyle(.bordered) }
    }

    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
