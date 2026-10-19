import {
  buildSessionCreateParams,
  buildSessionSendParams,
  buildSessionSubscribeParams,
} from "../src/relay/params";

describe("session/send params", () => {
  it("uses the verified shape with the content key", () => {
    expect(buildSessionSendParams("sess_1", "hello")).toEqual({
      sessionId: "sess_1",
      content: "hello",
      modelSelection: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        options: { reasoningLevel: "max" },
      },
    });
  });

  it("never sends the rejected text key", () => {
    const json = JSON.stringify(buildSessionSendParams("sess_1", "hello"));
    expect(json).toContain('"content"');
    expect(json).not.toContain('"text"');
  });
});

describe("session/create params", () => {
  it("uses the verified workspace/model/mode shape", () => {
    expect(
      buildSessionCreateParams({
        workspacePath: "/Users/me/proj",
        workspaceKey: "proj",
        mode: "edit",
      }),
    ).toEqual({
      workspace: { workspacePath: "/Users/me/proj", workspaceKey: "proj" },
      model: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        options: { reasoningLevel: "max" },
      },
      mode: "edit",
    });
  });
});

describe("session/subscribe params", () => {
  it("requests the web-remote-replayable delivery", () => {
    expect(buildSessionSubscribeParams("sess_1")).toEqual({
      sessionId: "sess_1",
      deliveryKind: "web-remote-replayable",
    });
  });
});
