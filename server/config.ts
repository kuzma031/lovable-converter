export const config = {
  IS_TESTING: false,
  DEBUG: {
    SAVE_ANALYSIS: true, // Save analysis JSON file to analysis folder
    SAVE_MIGRATION_PLAN: true, // Save migration plan JSON file to migration-plan folder
    LOGS: true, // Log messages to console
  },
  TESTING_PROJECT_ID: "crypto-crownfunding", // hardcoded project id for debuggings
  SEND_COMPONENTS_TO_AI: true, // whether to send components to ai on convert step - false to save tokens when debugging
  DEFAULT_AI_MODEL: "gpt-4.1-mini", // Default AI model to use
  CONVERSION_CONCURRENCY: 10, // Max concurrent API calls to AI to avoid rate limits while still parallelizing - https://developers.openai.com/api/reference/resources/organization/subresources/projects/subresources/rate_limits/methods/get_rate_limits
};
