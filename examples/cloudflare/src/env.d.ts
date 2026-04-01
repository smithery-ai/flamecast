declare module "*.txt" {
  const content: string;
  export default content;
}

interface Env {
  E2B_API_KEY: string;
  RESTATE_INGRESS_URL?: string;
}
