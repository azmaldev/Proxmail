function ts(): string {
  return new Date().toISOString();
}

export function info(msg: string): void {
  console.log(`${ts()} - INFO - ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`${ts()} - WARN - ${msg}`);
}

export function error(msg: string): void {
  console.error(`${ts()} - ERROR - ${msg}`);
}
