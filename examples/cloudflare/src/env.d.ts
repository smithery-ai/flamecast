declare module "*.txt" {
  const content: string;
  export default content;
}

interface Env {
  HYPERDRIVE: Hyperdrive;
  E2B_API_KEY: string;
}
