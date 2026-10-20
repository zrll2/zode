import { canAttach, describeAttachment, formatBytes, guessMime, MAX_ATTACHMENTS } from "../src/attachments";

describe("canAttach", () => {
  it("allows up to 6 attachments of at most 8 MiB", () => {
    expect(canAttach(0, 100)).toBe(true);
    expect(canAttach(5, 8 * 1024 * 1024)).toBe(true);
    expect(canAttach(6, 100)).toBe(false);
    expect(canAttach(1, 8 * 1024 * 1024 + 1)).toBe(false);
    expect(canAttach(1, -1)).toBe(false);
  });

  it("exposes the limits as constants", () => {
    expect(MAX_ATTACHMENTS).toBe(6);
  });
});

describe("guessMime", () => {
  it("maps known extensions", () => {
    expect(guessMime("photo.jpg")).toBe("image/jpeg");
    expect(guessMime("photo.jpeg")).toBe("image/jpeg");
    expect(guessMime("scan.PDF")).toBe("application/pdf");
    expect(guessMime("notes.md")).toBe("text/markdown");
    expect(guessMime("data.json")).toBe("application/json");
    expect(guessMime("table.csv")).toBe("text/csv");
    expect(guessMime("clip.webp")).toBe("image/webp");
    expect(guessMime("shot.heic")).toBe("image/heic");
    expect(guessMime("book.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(guessMime("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(guessMime("bundle.zip")).toBe("application/zip");
  });

  it("falls back to octet-stream", () => {
    expect(guessMime("mystery.bin")).toBe("application/octet-stream");
    expect(guessMime("noextension")).toBe("application/octet-stream");
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(270)).toBe("270 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});

describe("describeAttachment", () => {
  it("reads a history file part with metadata", () => {
    expect(
      describeAttachment({
        type: "file",
        mime: "image/png",
        url: "zcode-artifact://x",
        metadata: { sizeBytes: 270, image: { width: 8, height: 8 } },
      }),
    ).toEqual({ label: "image/png", image: true, sizeBytes: 270 });
  });

  it("handles a part without metadata", () => {
    expect(describeAttachment({ type: "file", mime: "application/pdf" })).toEqual({
      label: "application/pdf",
      image: false,
      sizeBytes: 0,
    });
  });

  it("falls back to octet-stream without a mime", () => {
    expect(describeAttachment({ type: "file" })).toEqual({
      label: "application/octet-stream",
      image: false,
      sizeBytes: 0,
    });
    expect(describeAttachment(null)).toEqual({
      label: "application/octet-stream",
      image: false,
      sizeBytes: 0,
    });
  });
});
