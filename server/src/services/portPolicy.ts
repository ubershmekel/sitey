import { db } from "../lib/db.ts";
import { docker } from "./docker.ts";

/** Recreate legacy runtime containers using their existing image and settings.
 * Docker cannot remove published ports in place. Named data volumes survive.
 * Run before accepting deployment requests, so this cannot race a deployment.
 */
export async function removeLegacyPortBindings(): Promise<void> {
  const containers = await docker.listContainers({ all: true });
  for (const info of containers) {
    const name = info.Names.map((n) => n.replace(/^\//, "")).find((n) =>
      /^sitey-(?:service-|project-)?\d+$/.test(n),
    );
    if (!name) continue;
    const id = Number(name.match(/\d+$/)![0]);
    const service = await db.service.findUnique({ where: { id } });
    if (!service || service.protected) continue;
    const old = docker.getContainer(info.Id);
    const inspected = await old.inspect();
    const bindings = inspected.HostConfig.PortBindings ?? {};
    if (
      !inspected.HostConfig.PublishAllPorts &&
      !Object.values(bindings).some((v) => Array.isArray(v) && v.length)
    )
      continue;

    console.warn(`[ports] Recreating ${name} without public host ports`);
    // Fail closed: an old container must not reopen its ports after a restart.
    await old.update({ RestartPolicy: { Name: "no" } });
    if (inspected.State.Running) await old.stop({ t: 10 });
    await old.remove(); // Do not remove volumes or the image.
    try {
      const replacement = await docker.createContainer({
        ...inspected.Config,
        Image: inspected.Image,
        name,
        HostConfig: {
          ...inspected.HostConfig,
          PortBindings: {},
          PublishAllPorts: false,
        },
      });
      if (inspected.State.Running && service.active) await replacement.start();
      await db.service.update({
        where: { id },
        data: {
          hostPort: null,
          containerId: replacement.id,
          containerName: name,
        },
      });
    } catch (err) {
      await db.service.update({
        where: { id },
        data: {
          hostPort: null,
          status: "failed",
          containerId: null,
          containerName: null,
        },
      });
      console.error(
        `[ports] ${name} is stopped; its data is retained. Redeploy it to recover:`,
        err,
      );
    }
  }
  await db.service.updateMany({
    where: { hostPort: { not: null } },
    data: { hostPort: null },
  });
}
