import { addArchived, archiveKey, isArchived, removeArchived } from "../src/sessionActions";

describe("archiveKey", () => {
  it("takes the 8 characters after sess_", () => {
    expect(archiveKey("sess_abcdefghij")).toBe("abcdefgh");
  });

  it("falls back to the whole id without the prefix", () => {
    expect(archiveKey("demo-login-redirect")).toBe("demo-login-redirect");
  });
});

describe("archived id lists", () => {
  it("adds without duplicates and reports membership", () => {
    let list = addArchived([], "sess_aaaa1111");
    list = addArchived(list, "sess_aaaa1111");
    expect(list).toEqual(["aaaa1111"]);
    expect(isArchived(list, "sess_aaaa1111")).toBe(true);
    expect(isArchived(list, "sess_zzzz9999")).toBe(false);
  });

  it("caps at 150 keys, dropping the oldest", () => {
    let list: string[] = [];
    for (let index = 0; index < 160; index += 1) {
      list = addArchived(list, `sess_${String(index).padStart(8, "0")}`);
    }
    expect(list).toHaveLength(150);
    expect(list[0]).toBe("00000159");
    expect(list).not.toContain("00000000");
    expect(list).not.toContain("00000009");
    expect(list).toContain("00000010");
  });

  it("removes a key and leaves the rest in order", () => {
    const list = addArchived(addArchived([], "sess_aaaa1111"), "sess_bbbb2222");
    expect(removeArchived(list, "sess_aaaa1111")).toEqual(["bbbb2222"]);
    expect(removeArchived(list, "sess_nope0000")).toEqual(["bbbb2222", "aaaa1111"]);
  });
});
