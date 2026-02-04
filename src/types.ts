import * as v from "valibot";

export type PromptType = "text" | "select" | "confirm";
export type PromptOption = string | { label: string; value: string; hint?: string };
export type PromptConfig = {
    name: string;
    type: PromptType;
    message: string;
    initial?: string;
    options?: PromptOption[];
};
export type CreaterConfig = {
    name?: string;
    description?: string;
    prompts?: PromptConfig[];
    files?: {
        include?: string[];
        exclude?: string[];
        copyFrom?: string[];
    };
};

export type TemplateSource =
    | { kind: "local"; root: string }
    | { kind: "github"; repo: string; path: string | null };

export const promptOptionSchema = v.union([
    v.string(),
    v.object({
        label: v.string(),
        value: v.string(),
        hint: v.optional(v.string()),
    }),
]);
export const promptSchema = v.object({
    name: v.string(),
    type: v.picklist(["text", "select", "confirm"]),
    message: v.string(),
    initial: v.optional(v.string()),
    options: v.optional(v.array(promptOptionSchema)),
});
export const configSchema = v.object({
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    prompts: v.optional(v.array(promptSchema)),
    files: v.optional(
        v.object({
            include: v.optional(v.array(v.string())),
            exclude: v.optional(v.array(v.string())),
            copyFrom: v.optional(v.array(v.string())),
        }),
    ),
});

export const GConfigSchema = v.object({
    cache:v.object({
        ttl:v.number()
    })
})