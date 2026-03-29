declare module "*.txt" {
  const content: string;
  export default content;
}

interface Env {
  HYPERDRIVE: Hyperdrive;
  E2B_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}
