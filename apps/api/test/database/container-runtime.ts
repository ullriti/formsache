import { getContainerRuntimeClient } from 'testcontainers';

let probe: Promise<boolean> | undefined;

/**
 * Asks the container runtime itself whether it is reachable.
 *
 * The check deliberately does not look at `DOCKER_HOST` or at the existence of
 * a socket file: both describe a daemon that *should* be there.
 * `getContainerRuntimeClient()` walks testcontainers' own strategy list
 * (socket, `DOCKER_HOST`, rootless paths, Podman) and talks to whatever it
 * finds. Only an answer counts — an environment variable pointing at a dead
 * daemon must not make us claim that the requirement ran on Testcontainers.
 *
 * The result is cached per worker process: the discovery is slow when nothing
 * answers, and it cannot change while the process runs.
 */
export function isContainerRuntimeAvailable(): Promise<boolean> {
  probe ??= getContainerRuntimeClient().then(
    () => true,
    () => false,
  );
  return probe;
}
