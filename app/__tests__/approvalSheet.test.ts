import { approvalActionsState } from "../src/ui/ApprovalSheet";

it("shows the buttons until the request is answered", () => {
  expect(approvalActionsState(false, null)).toEqual({ showButtons: true, feedback: null });
});

it("reports an answer given on the Mac", () => {
  expect(approvalActionsState(true, null)).toEqual({
    showButtons: false,
    feedback: "Answered on your Mac",
  });
});

it("reports the local decision while the parent closes the sheet", () => {
  expect(approvalActionsState(false, "allow")).toEqual({
    showButtons: false,
    feedback: "Allowed",
  });
  expect(approvalActionsState(false, "deny")).toEqual({
    showButtons: false,
    feedback: "Denied",
  });
});
