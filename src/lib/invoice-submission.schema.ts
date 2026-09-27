import { z } from "zod";

export const submitInvoiceSchema = z.object({
  title: z
    .string()
    .min(1, "title is required"),
  description: z
    .string()
    .min(1, "description is required"),
  faceValue: z
    .union([z.number(), z.string()])
    .transform((val: unknown, ctx: z.RefinementCtx) => {
      const num = typeof val === "number" ? val : parseFloat(val as string);
      if (isNaN(num)) {
        ctx.addIssue({ code: "custom", message: "faceValue must be a valid number" });
        return z.NEVER;
      }
      return num;
    })
    .pipe(z.number().positive("faceValue must be positive")),
  fundingTarget: z
    .union([z.number(), z.string()])
    .transform((val: unknown, ctx: z.RefinementCtx) => {
      const num = typeof val === "number" ? val : parseFloat(val as string);
      if (isNaN(num)) {
        ctx.addIssue({ code: "custom", message: "fundingTarget must be a valid number" });
        return z.NEVER;
      }
      return num;
    })
    .pipe(z.number().positive("fundingTarget must be positive")),
  yieldBps: z
    .union([z.number(), z.string()])
    .transform((val: unknown, ctx: z.RefinementCtx) => {
      const num = typeof val === "number" ? val : parseInt(val as string, 10);
      if (isNaN(num)) {
        ctx.addIssue({ code: "custom", message: "yieldBps must be an integer" });
        return z.NEVER;
      }
      return num;
    })
    .pipe(
      z
        .number()
        .int("yieldBps must be an integer")
        .min(1, "yieldBps must be between 1 and 5000")
        .max(5000, "yieldBps must be between 1 and 5000")
    ),
  fundingDeadline: z
    .union([z.string(), z.date()])
    .transform((val: unknown, ctx: z.RefinementCtx) => {
      const d = val instanceof Date ? val : new Date(val as string);
      if (isNaN(d.getTime())) {
        ctx.addIssue({
          code: "custom",
          message: "fundingDeadline must be a valid date",
        });
        return z.NEVER;
      }
      if (d.getTime() <= Date.now()) {
        ctx.addIssue({
          code: "custom",
          message: "fundingDeadline must be in the future",
        });
        return z.NEVER;
      }
      return d;
    }),
  ipfsDocumentUrl: z
    .string()
    .min(1, "ipfsDocumentUrl is required"),
});

export type SubmitInvoiceDTO = z.infer<typeof submitInvoiceSchema>;
