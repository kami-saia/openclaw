import { Type } from "typebox";
import {
  CHANNEL_TARGET_DESCRIPTION,
  CHANNEL_TARGETS_DESCRIPTION,
} from "../../infra/outbound/channel-target.js";
export { optionalStringEnum, stringEnum } from "./string-enum.js";

export function channelTargetSchema(options?: { description?: string }) {
  return Type.String({
    description: options?.description ?? CHANNEL_TARGET_DESCRIPTION,
  });
}

export function channelTargetsSchema(options?: { description?: string }) {
  return Type.Array(
    channelTargetSchema({ description: options?.description ?? CHANNEL_TARGETS_DESCRIPTION }),
  );
}

type IntegerSchemaOptions = {
  description?: string;
  maximum?: number;
};

type NumberSchemaOptions = {
  description?: string;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
};

export function optionalFiniteNumberSchema(options: NumberSchemaOptions = {}) {
  return Type.Optional(Type.Number(options));
}

export function optionalPositiveIntegerSchema(options: IntegerSchemaOptions = {}) {
  // FORK: emit Type.Number (not Type.Integer) so the JSON schema type is
  // "number" rather than "integer". Gemini rejects "integer"-typed tool params,
  // so all our integer-valued tool inputs must serialize as "number".
  return Type.Optional(
    Type.Number({
      minimum: 1,
      ...options,
    }),
  );
}

export function optionalNonNegativeIntegerSchema(options: IntegerSchemaOptions = {}) {
  // FORK: Type.Number for Gemini compatibility (see optionalPositiveIntegerSchema).
  return Type.Optional(
    Type.Number({
      minimum: 0,
      ...options,
    }),
  );
}
