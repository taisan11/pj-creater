import {toJsonSchema} from "@valibot/to-json-schema"
import { configSchema } from "../src/types";

const jsonSchema = toJsonSchema(configSchema);
Bun.write("schema/createrConfig.schema.json", JSON.stringify(jsonSchema, null, 2));