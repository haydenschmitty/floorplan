// The app module wires the sched service through Nest's DI at boot; nothing
// imports the class directly, so only the name match can quiet it.
export const BOOT_JOBS = ['sched'];
