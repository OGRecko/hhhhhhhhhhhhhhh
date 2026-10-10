import { execFileSync } from "node:child_process";

const project = process.env.CLOUD_TASKS_PROJECT_ID;
const location = process.env.CLOUD_TASKS_LOCATION || "us-central1";
const queue = process.env.CLOUD_TASKS_QUEUE || "cavity-solver";
if (!project) throw new Error("CLOUD_TASKS_PROJECT_ID is required");
if (!/^[a-z][a-z0-9-]{0,62}$/.test(location)) throw new Error("Invalid CLOUD_TASKS_LOCATION");
if (!/^[a-z][a-z0-9-]{0,99}$/.test(queue)) throw new Error("Invalid CLOUD_TASKS_QUEUE");

function gcloud(args) {
  return execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
try {
  gcloud(["tasks", "queues", "describe", queue, `--location=${location}`, `--project=${project}`, "--format=json"]);
  console.log(`Cloud Tasks queue exists: ${project}/${location}/${queue}`);
} catch {
  gcloud(["tasks", "queues", "create", queue, `--location=${location}`, `--project=${project}`]);
  console.log(`Created Cloud Tasks queue: ${project}/${location}/${queue}`);
}
