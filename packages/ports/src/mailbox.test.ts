import { describe, expect, it } from "vitest";
import { MAILBOX_OPERATIONS, parseRawEmail, replyTokenOf } from "./mailbox.ts";

describe("mailbox MIME reader", () => {
  it("reads a plain message and decodes encoded-word subjects", () => {
    const r = parseRawEmail(
      "Subject: =?utf-8?q?Re=3A_caf=C3=A9?=\r\nFrom: a@b.c\r\n\r\nHello there\r\n",
    );
    expect(r.headers.subject).toBe("Re: café");
    expect(r.text).toBe("Hello there");
  });
  it("takes the text/plain part of a multipart message (quoted-printable, base64)", () => {
    const qp = [
      'Content-Type: multipart/alternative; boundary="x"',
      "",
      "preamble",
      "--x",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "How much=3F =",
      "Thanks",
      "--x",
      "Content-Type: text/html",
      "",
      "<p>no</p>",
      "--x--",
    ].join("\r\n");
    expect(parseRawEmail(qp).text).toBe("How much? Thanks");
    const b64 = [
      "Content-Type: multipart/mixed; boundary=y",
      "",
      "--y",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("Yes please"),
      "--y--",
    ].join("\n");
    expect(parseRawEmail(b64).text).toBe("Yes please");
  });
  it("finds the outbox id in a replies+<id>@ subaddress", () => {
    expect(replyTokenOf("replies+0b1c2d3e-aaaa-bbbb-cccc-000000000000@mail.example")).toBe(
      "0b1c2d3e-aaaa-bbbb-cccc-000000000000",
    );
    expect(replyTokenOf("replies@mail.example")).toBeNull();
  });
  it("the port has no send, delete or forward operation", () => {
    expect([...MAILBOX_OPERATIONS]).toEqual(["list", "read", "createDraft"]);
  });
});
