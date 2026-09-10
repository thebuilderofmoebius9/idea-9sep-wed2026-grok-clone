import test from "node:test";
import assert from "node:assert/strict";
import { resolveMentions, mentionToken, displayNames, excludedRanges } from "../src/mentions.mjs";

const research = { id: "11111111-1111-4111-8111-111111111111", name: "Research" };
const writer = { id: "22222222-2222-4222-8222-222222222222", name: "Writing Partner" };
const members = [research, writer];

test("bare and quoted mentions resolve in first-occurrence order", () => {
  const result = resolveMentions('@"Writing Partner" ช่วยดู แล้ว @Research สรุป แล้ว @Research อีกครั้ง', members);
  assert.equal(result.hasMentions, true);
  assert.deepEqual(result.ordered.map((item) => item.name), ["Writing Partner", "Research"]);
});

test("a mention must start at a boundary, so an email local part stays literal", () => {
  assert.equal(resolveMentions("ส่งไป nat@Research.com", members).hasMentions, false);
  assert.equal(resolveMentions("(@Research)", members).ordered.length, 1);
});

test("code spans, fences and URLs are routing exclusions", () => {
  assert.equal(resolveMentions("`@Research`", members).hasMentions, false);
  assert.equal(resolveMentions("```\n@Research\n```", members).hasMentions, false);
  assert.equal(resolveMentions("~~~\n@Research\n~~~", members).hasMentions, false);
  assert.equal(resolveMentions("ดู https://x.example/@Research นะ", members).hasMentions, false);
  assert.equal(resolveMentions("ดู www.x.example/@Research นะ", members).hasMentions, false);
});

test("an unmatched inline backtick run stays literal so the mention still routes", () => {
  assert.equal(resolveMentions("`` @Research", members).ordered.length, 1);
});

test("an inline run cannot pair across a fence boundary", () => {
  const text = "`a`\n```\n@Research\n```\n@Research";
  const result = resolveMentions(text, members);
  assert.equal(result.ordered.length, 1, "เฉพาะตัวที่อยู่นอก fence เท่านั้นที่นับ");
});

test("an unclosed fence extends to the end of the draft", () => {
  assert.equal(resolveMentions("```\n@Research", members).hasMentions, false);
});

test("a routing escape produces a literal at sign in the readable text", () => {
  const result = resolveMentions("\\@Research คือชื่อ handle", members);
  assert.equal(result.hasMentions, false);
  assert.equal(result.readableText, "@Research คือชื่อ handle");
});

test("a bound token routes and its identifier is stripped from readable text", () => {
  const result = resolveMentions(`${mentionToken(writer)} เริ่มเลย`, members);
  assert.deepEqual(result.ordered, [{ id: writer.id, name: writer.name }]);
  assert.equal(result.readableText, '@"Writing Partner" เริ่มเลย');
  assert.ok(!result.readableText.includes(writer.id));
});

test("a renamed or removed binding is stale rather than silently redirected", () => {
  const renamed = [{ ...writer, name: "Writing Partner II" }, research];
  assert.throws(() => resolveMentions(mentionToken(writer), renamed), (error) => error.code === "stale");
  assert.throws(() => resolveMentions(mentionToken(writer), [research]), (error) => error.code === "stale");
});

test("unknown, ambiguous and malformed mentions each block the whole send", () => {
  assert.throws(() => resolveMentions("@Nobody", members), (error) => error.code === "unknown");
  const duplicated = [research, { id: "33333333-3333-4333-8333-333333333333", name: "Research" }];
  assert.throws(() => resolveMentions("@Research", duplicated), (error) => error.code === "ambiguous");
  assert.throws(() => resolveMentions('@"unclosed', members), (error) => error.code === "malformed");
  assert.throws(() => resolveMentions("@Research{not-a-uuid}", members), (error) => error.code === "malformed");
  assert.throws(() => resolveMentions(`@Research and @Nobody`, members), (error) => error.code === "unknown");
});

test("names match case-sensitively after NFC normalization", () => {
  assert.throws(() => resolveMentions("@research", members), (error) => error.code === "unknown");
  const thai = [{ id: "44444444-4444-4444-8444-444444444444", name: "ผู้ช่วย" }];
  assert.equal(resolveMentions("@ผู้ช่วย".normalize("NFD"), thai).ordered.length, 1);
});

test("more than six distinct mentions is refused", () => {
  const many = Array.from({ length: 7 }, (unused, index) => ({
    id: `5555555${index}-5555-4555-8555-555555555555`, name: `Bot${index}`,
  }));
  const draft = many.map((member) => `@${member.name}`).join(" ");
  assert.throws(() => resolveMentions(draft, many), (error) => error.code === "tooMany");
});

test("duplicate names get a distinguishing identity prefix for menus and confirmation", () => {
  const duplicated = [research, { id: "33333333-3333-4333-8333-333333333333", name: "Research" }];
  const labels = displayNames(duplicated).map((item) => item.display);
  assert.equal(new Set(labels).size, 2);
  assert.ok(labels.every((label) => label.startsWith("Research")));
  assert.equal(displayNames([research])[0].display, "Research");
});

test("excluded ranges are reported for a fence plus an inline span", () => {
  const ranges = excludedRanges("ก `x` ข\n```\ny\n```\n");
  assert.ok(ranges.length >= 2);
});
