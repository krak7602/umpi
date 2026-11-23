import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPublishable, DENY_FILE, isExampleHost, isPrivatePath, looksInvented, looksRandom, mask, parseDenyList, scanDenyList, scanText,
} from "../scripts/check-publishable.ts";

// Every value here is invented. The credential-shaped ones are built from parts so that this file has no hit.
const RANDOM = "q7Rk2Zp9Lm4Xw8Tn3Vb6Yc1Hd5Jf0Gs";
const HEX64 = "9f3c1e7a".repeat(2) + "4b8d2f6055aa13c7e9d04b6f" + "71c2e83a5d9b0f46e2a7c318";

const categories = (text: string): string[] => scanText(text).map((finding) => finding.category);

test("provider credential shapes are reported", () => {
  assert.deepEqual(categories(`key = sk-ant-api03-${RANDOM}`), ["anthropic-credential"]);
  assert.deepEqual(categories(`refresh sk-ant-ort01-${RANDOM}`), ["anthropic-credential"]);
  assert.deepEqual(categories(`sk-proj-${RANDOM}`), ["openai-credential"]);
  assert.deepEqual(categories(`eyJ${RANDOM}.eyJ${RANDOM}.${RANDOM}`), ["jwt"]);
  assert.deepEqual(categories(`ya29.${RANDOM}`), ["google-credential"]);
  assert.deepEqual(categories(`GOCSPX-${RANDOM}`), ["google-credential"]);
  assert.deepEqual(categories(`482913765:AAH${RANDOM}k`), ["telegram-bot-token"]);
  assert.deepEqual(categories(`Authorization: Bearer ${RANDOM}`), ["bearer-token"]);
  assert.deepEqual(categories(`const apiKey = "${RANDOM}${RANDOM}";`), ["assigned-secret"]);
  assert.deepEqual(categories(`UMPI_CONTROL_TOKEN=${RANDOM}${RANDOM}`), ["assigned-secret"]);
});

test("invented credential values are not reported", () => {
  assert.deepEqual(categories("401 Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz rejected; key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ"), []);
  assert.deepEqual(categories('executorToken: "not-a-real-token-with-at-least-32-characters"'), []);
  assert.deepEqual(categories("Authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}`"), []);
  assert.deepEqual(categories("UMPI_CONTROL_TOKEN=replace-with-a-random-value-of-32-characters"), []);
  assert.equal(looksInvented("a".repeat(64)), true);
  assert.equal(looksInvented("0123456789abcdef".repeat(4)), true);
  assert.equal(looksInvented("example-device-token"), true);
  assert.equal(looksInvented(RANDOM), false);
  assert.equal(looksRandom(RANDOM), true);
  assert.equal(looksRandom("onlylettersinthisvaluewithoutdigits"), false);
});

test("a private key block is reported only with key material", () => {
  const body = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgq7Rk2Zp9Lm4Xw8Tn";
  assert.deepEqual(categories(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`), ["private-key"]);
  assert.deepEqual(categories(`const pem = "-----BEGIN EC PRIVATE KEY-----\\n${body}\\n-----END EC PRIVATE KEY-----";`), ["private-key"]);
  assert.deepEqual(categories("const match = /^-----BEGIN PRIVATE KEY-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END PRIVATE KEY-----$/.exec(pem);"), []);
  assert.deepEqual(categories("APNS_PRIVATE_KEY is the PKCS#8 .p8 PEM (-----BEGIN PRIVATE KEY-----), with literal \\n escapes."), []);
});

test("Apple and Cloudflare identifiers need their context words", () => {
  assert.deepEqual(categories("DEVELOPMENT_TEAM = 7QX4M2K9PL"), ["apple-identifier"]); // publishable-ok: invented
  assert.deepEqual(categories('APNS_KEY_ID="B4N8T2W6ZC"'), ["apple-identifier"]); // publishable-ok: invented
  assert.deepEqual(categories("The serial 7QX4M2K9PL is printed on the kettle."), []);
  assert.deepEqual(categories("DEVELOPMENT_TEAM = PRODUCTION"), []);
  assert.deepEqual(categories("PRODUCT_BUNDLE_IDENTIFIER = com.teapotworks.kettle"), ["bundle-identifier"]); // publishable-ok: invented
  assert.deepEqual(categories("PRODUCT_BUNDLE_IDENTIFIER = org.example.umpi.widgets"), []);
  assert.deepEqual(categories('Logger(subsystem: "com.apple.kettle", category: "push")'), []);
  assert.deepEqual(categories('"account_id": "3e9a71c05b8d4f26a0c7e15d9b3f8a42"'), ["cloudflare-identifier"]); // publishable-ok: invented
  assert.deepEqual(categories('"account_id": "00000000000000000000000000000000"'), []);
  assert.deepEqual(categories('TELEGRAM_OWNER_ID="5820394716"'), ["telegram-identifier"]); // publishable-ok: invented
  assert.deepEqual(categories("ownerId: 42, chatId: 1000001"), []);
});

test("a 64-hex device token is reported unless it is a labelled hash or invented", () => {
  assert.deepEqual(categories(`apns: "${HEX64}"`), ["device-token"]);
  assert.deepEqual(categories(`sha256: "${HEX64}"`), []);
  assert.deepEqual(categories(`// sha256 of the two invented names:\n  "${HEX64}"`), []);
  assert.deepEqual(categories(`token: "${"ab".repeat(32)}"`), []);
  assert.deepEqual(categories(`longer: "${HEX64}ab"`), []);
});

test("deployment origins are reported unless they are documented examples", () => {
  assert.deepEqual(categories("curl https://umpi.kettle-works.workers.dev/health"), ["deployment-origin"]); // publishable-ok: invented
  assert.deepEqual(categories("see kettle.pages.dev for the preview"), ["deployment-origin"]); // publishable-ok: invented
  assert.deepEqual(categories("https://assistant.umpi-kettle.net/api"), ["deployment-origin"]); // publishable-ok: invented
  assert.deepEqual(categories("https://umpi.example.workers.dev and https://umpi.your-subdomain.workers.dev"), []);
  assert.deepEqual(categories("https://umpi.example/api and https://coordinator.example.com"), []);
  assert.deepEqual(categories("It disables `workers.dev` and preview URLs."), []);
  assert.equal(isExampleHost("umpi.example"), true);
  assert.equal(isExampleHost("docs.example.org"), true);
  assert.equal(isExampleHost("kettle-works.net"), false);
});

test("email addresses are reported unless they are examples, no-reply addresses, or not mailboxes", () => {
  assert.deepEqual(categories("Contact rowan.finch@kettle-works.net for access."), ["email"]); // publishable-ok: invented
  assert.deepEqual(categories("reader@example.com, owner@example.org, bot@service.test"), []);
  assert.deepEqual(categories("Co-Authored-By: Helper <noreply@kettle-works.net>"), []);
  assert.deepEqual(categories("4821+rowan@users.noreply.github.com"), []);
  assert.deepEqual(categories("git clone git@github.com:kettle/works.git"), []);
  assert.deepEqual(categories("https://user:secret@cdn.kettle-works.net/asset"), []);
  assert.deepEqual(categories("AppIcon@2x.png and npm install tsx@4.23.15"), []);
});

test("the allow marker accepts its own line or the next line", () => {
  assert.deepEqual(categories("mail rowan.finch@kettle-works.net // publishable-ok: invented"), []);
  assert.deepEqual(categories("<!-- publishable-ok-next-line -->\nmail rowan.finch@kettle-works.net"), []); // publishable-ok: invented
  assert.deepEqual(categories("// publishable-ok-next-line\n\nmail rowan.finch@kettle-works.net"), ["email"]);
  assert.deepEqual(scanText("first\nsecond rowan.finch@kettle-works.net").map((finding) => finding.line), [2]);
});

test("the deny-list reports line numbers and never the matched text", () => {
  const { patterns, invalid } = parseDenyList("# names\n\nrowan\\s+finch\n(unclosed\nkettle-works\\.net\n");
  assert.deepEqual(patterns.map((entry) => entry.line), [3, 5]);
  assert.deepEqual(invalid, [4]);
  const hits = scanDenyList("line one\nWritten by ROWAN  Finch\nhttps://kettle-works.net and Rowan Finch\n", patterns);
  assert.deepEqual(hits, [{ line: 2, patternLine: 3 }, { line: 3, patternLine: 3 }, { line: 3, patternLine: 5 }]);
  assert.deepEqual(scanDenyList("nothing private here", patterns), []);
  assert.equal(mask("sk-ant-api03-abcdef"), "sk-a… (19 characters)");
});

test("private paths are never opened", () => {
  for (const path of ["wrangler.local.jsonc", ".dev.vars", ".dev.vars.production", ".env", "ios/Config/Signing.local.xcconfig", ".wrangler/state/v3/d1.sqlite", "keys/AuthKey.p8", "certs/server.pem", DENY_FILE, ".git/config", "docs/../.dev.vars"]) {
    assert.equal(isPrivatePath(path), true, path);
  }
  for (const path of [".dev.vars.example", "wrangler.jsonc", "ios/Config/Signing.example.xcconfig", "ios/Config/Base.xcconfig", "src/worker/index.ts", "docs/keys.md"]) {
    assert.equal(isPrivatePath(path), false, path);
  }
});

test("the staged check reads the index, skips private and ignored files, and hides deny-list matches", () => {
  const root = mkdtempSync(join(tmpdir(), "umpi-publishable-"));
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
  try {
    git("init", "--quiet");
    git("config", "user.name", "Kettle Contributors");
    git("config", "user.email", "contributors@example.org");
    writeFileSync(join(root, ".gitignore"), `.dev.vars\n${DENY_FILE}\nprivate/\n`);
    writeFileSync(join(root, DENY_FILE), "rowan\\s+finch\n");
    writeFileSync(join(root, ".dev.vars"), `UMPI_CONTROL_TOKEN=${RANDOM}${RANDOM}\n`);
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "notes.txt"), "mail rowan.finch@kettle-works.net\n"); // publishable-ok: invented
    writeFileSync(join(root, "clean.ts"), "export const greeting = \"hello\";\n");
    writeFileSync(join(root, "leak.ts"), `const name = "Rowan Finch";\nconst key = "sk-ant-api03-${RANDOM}";\n`);
    git("add", ".gitignore", "clean.ts", "leak.ts");
    git("add", "-f", ".dev.vars");
    // The working tree is cleaned after staging; the commit would still hold the staged text.
    writeFileSync(join(root, "leak.ts"), "export {};\n");

    const staged = checkPublishable(root);
    assert.deepEqual(staged.hits.map((hit) => `${hit.path}:${hit.line}:${hit.category}`), [".dev.vars:1:private-file", "leak.ts:1:deny-list", "leak.ts:2:anthropic-credential"]);
    assert.equal(staged.files, 3);
    const printed = JSON.stringify(checkPublishable(root, { preview: true }));
    assert.equal(/rowan|finch/i.test(printed), false);
    assert.equal(printed.includes(RANDOM), false);
    assert.match(printed, /pattern on line 1 of \.publishable-deny\.local/);

    // `--all` reads the working tree: the cleaned file has no hit, and the ignored directory is not read.
    const all = checkPublishable(root, { all: true });
    assert.deepEqual(all.hits.map((hit) => `${hit.path}:${hit.category}`), [".dev.vars:private-file"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
