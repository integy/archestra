import type { archestraApiTypes } from "@archestra/shared";

type Dispatch = NonNullable<
  archestraApiTypes.CreateDevFeedbackCommentResponses["200"]["dispatch"]
>;

export function devFeedbackDispatchMessage(dispatch: Dispatch): string {
  switch (dispatch.status) {
    case "started":
      return "Agent review started. Open its run or Slack thread for updates.";
    case "pending":
      return "Agent review is queued for this Slack thread.";
    case "failed":
    case "uncertain":
      return (
        dispatch.message ??
        "Your feedback was posted, but agent review needs attention."
      );
  }
}
