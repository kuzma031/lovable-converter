import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AnalysisResult, MigrationPlan } from "../types/index";
import openAIClient from "../openai/index";

const MigrationPlanSchema = z.object({
  routingStrategy: z.literal("next-app-router"),
  layoutStrategy: z.string(),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});

export async function generateMigrationPlan(analysis: AnalysisResult) {
  const userPrompt = `
  Given this analysis of a React + Vite project, create a migration plan to
  Next.js App Router.

  Project analysis (JSON):
  ${JSON.stringify(analysis, null, 2)}

  Rules:
  - No code output
  - Be explicit
  - Do not invent routes
  - Assume client components only
  `;

  //   const response = await openAIClient.responses.parse({
  //     model: "gpt-4.1-mini",
  //     temperature: 0,
  //     instructions:
  //       "You are a senior frontend architect. You produce strict JSON only.",
  //     input: userPrompt,
  //     text: {
  //       format: zodTextFormat(MigrationPlanSchema, "migration_plan"),
  //     },
  //   });

  //   const parsed = response.output_parsed;
  //   if (parsed == null) throw new Error("Empty or unparseable AI response");

  //   return parsed;
}
