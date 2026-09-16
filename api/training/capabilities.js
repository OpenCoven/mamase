import { createHostedCapabilities } from "../../hosted-training.mjs";

const capabilities = createHostedCapabilities();
export default (request, response) => capabilities(request, response);
