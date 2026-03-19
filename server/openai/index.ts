import OpenAI from "openai";
import "dotenv/config";

const openAIClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default openAIClient;
