import { z, type ZodType } from "zod"

type InjectSchemasOptions = {
	/**
	 * Schema IDs that use z.unknown() and should be marked with x-stainless-any.
	 * This suppresses Stainless SDK generator warnings for ambiguous types.
	 */
	ambiguousSchemas?: Set<string>
}

/**
 * Convert Zod schemas to JSON Schema and inject into OpenAPI spec components.schemas.
 * Also replaces inline schemas in paths with $ref pointers.
 *
 * @param spec - The OpenAPI spec object to modify in place
 * @param schemas - Array of Zod schemas with .meta({ id: "SchemaName" })
 * @param options - Optional configuration
 */
export function injectSchemas(
	spec: Record<string, unknown>,
	schemas: ZodType[],
	options?: InjectSchemasOptions,
): void {
	const components = (spec.components as Record<string, unknown>) || {}
	const schemasMap = (components.schemas as Record<string, unknown>) || {}

	for (const schema of schemas) {
		// Convert to JSON Schema - Zod v4 includes the id from .meta({ id }) in the output
		const jsonSchema = z.toJSONSchema(schema, {
			unrepresentable: "any",
		}) as Record<string, unknown>

		// Get the id from the generated JSON Schema
		const id = jsonSchema.id as string | undefined
		if (!id) continue

		// Remove the $schema and id fields from the JSON Schema (they shouldn't be in components.schemas)
		delete jsonSchema.$schema
		delete jsonSchema.id

		// Handle nested $defs - hoist them to components.schemas
		if (jsonSchema.$defs) {
			const defs = jsonSchema.$defs as Record<string, unknown>
			for (const [defId, defSchema] of Object.entries(defs)) {
				if (!schemasMap[defId]) {
					schemasMap[defId] = defSchema
				}
			}
			delete jsonSchema.$defs
		}

		schemasMap[id] = jsonSchema
	}

	// Rewrite all $refs from #/$defs/... to #/components/schemas/... across ALL schemas
	for (const schemaObj of Object.values(schemasMap)) {
		rewriteRefs(schemaObj)
	}

	// Mark ambiguous schemas (z.unknown()) with x-stainless-any to suppress warnings
	if (options?.ambiguousSchemas) {
		for (const schemaId of options.ambiguousSchemas) {
			const schema = schemasMap[schemaId] as Record<string, unknown> | undefined
			if (
				schema?.additionalProperties &&
				typeof schema.additionalProperties === "object"
			) {
				;(schema.additionalProperties as Record<string, unknown>)[
					"x-stainless-any"
				] = true
			}
		}
	}

	components.schemas = schemasMap
	spec.components = components

	// Replace inline schemas in paths with $ref pointers
	replaceInlineSchemasWithRefs(
		spec.paths as Record<string, unknown>,
		schemasMap,
	)
}

/**
 * Replace inline schemas that have an `id` matching a schema in components.schemas with $ref pointers.
 */
export function replaceInlineSchemasWithRefs(
	obj: unknown,
	schemas: Record<string, unknown>,
): void {
	if (!obj || typeof obj !== "object") return
	if (Array.isArray(obj)) {
		for (const item of obj) replaceInlineSchemasWithRefs(item, schemas)
		return
	}

	const record = obj as Record<string, unknown>

	for (const [key, value] of Object.entries(record)) {
		if (!value || typeof value !== "object") continue

		const valueRecord = value as Record<string, unknown>

		// If this object has an `id` that matches a schema in components.schemas, replace it with $ref
		if (
			valueRecord.id &&
			typeof valueRecord.id === "string" &&
			schemas[valueRecord.id]
		) {
			record[key] = { $ref: `#/components/schemas/${valueRecord.id}` }
		} else {
			replaceInlineSchemasWithRefs(value, schemas)
		}
	}
}

/**
 * Rewrite $refs from #/$defs/... to #/components/schemas/... format.
 */
export function rewriteRefs(obj: unknown): void {
	if (!obj || typeof obj !== "object") return
	if (Array.isArray(obj)) {
		for (const item of obj) rewriteRefs(item)
		return
	}
	const record = obj as Record<string, unknown>
	if (
		record.$ref &&
		typeof record.$ref === "string" &&
		record.$ref.startsWith("#/$defs/")
	) {
		record.$ref = record.$ref.replace("#/$defs/", "#/components/schemas/")
	}
	for (const value of Object.values(record)) {
		rewriteRefs(value)
	}
}
