import type { z, ZodType } from "zod"

export namespace BusEvent {
  export interface Event<Type extends string = string, Properties = unknown> {
    type: Type
    properties: Properties
  }

  export interface EventDefinition<Type extends string, Schema extends ZodType> {
    type: Type
    schema: Schema
    properties: Schema  // Alias for schema for compatibility
    create(properties: z.infer<Schema>): Event<Type, z.infer<Schema>>
  }

  export function define<Type extends string, Schema extends ZodType>(
    type: Type,
    schema: Schema
  ): EventDefinition<Type, Schema> {
    return {
      type,
      schema,
      properties: schema,  // Alias for compatibility
      create(properties: z.infer<Schema>) {
        return { type, properties }
      },
    }
  }
}

export namespace Bus {
  // Stub bus implementation - actual events come from SDK
}
