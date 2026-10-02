import type { NextFunction, Request, Response } from "express";
import type { ObjectSchema } from "joi";
import { HttpError } from "../utils/http-error";

export function validateBody(schema: ObjectSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      next(
        new HttpError(
          400,
          "Request validation failed.",
          error.details.map((detail) => detail.message)
        )
      );
      return;
    }

    req.body = value;
    next();
  };
}

export function validateQuery(schema: ObjectSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      next(
        new HttpError(
          400,
          "Query validation failed.",
          error.details.map((detail) => detail.message)
        )
      );
      return;
    }

    req.query = value;
    next();
  };
}
