import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  CreateDevFeedbackCommentBodySchema,
  DevFeedbackSetupSchema,
} from "./dev-feedback";

export const SelectDevFeedbackSubmissionSchema = createSelectSchema(
  schema.devFeedbackSubmissionsTable,
  {
    body: CreateDevFeedbackCommentBodySchema,
    target: DevFeedbackSetupSchema,
    deliveryStatus: z.enum(["posting", "media_pending", "posted", "uncertain"]),
    dispatchStatus: z.enum([
      "disabled",
      "pending",
      "launching",
      "started",
      "failed",
      "uncertain",
    ]),
    media: z.object({
      screenshot: z.enum(["absent", "uploaded", "unavailable", "unknown"]),
      clip: z.enum(["absent", "uploaded", "unavailable", "unknown"]),
    }),
  },
);
export type DevFeedbackSubmission = z.infer<
  typeof SelectDevFeedbackSubmissionSchema
>;
