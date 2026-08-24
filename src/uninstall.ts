import { rmSync } from 'node:fs'
import { removePinnedCli } from './install.js'
import { withOperationLock } from './lock.js'
import { assertDeployment } from './operations.js'
import { deploymentFiles } from './paths.js'
import { promptConfirm, promptNote, promptOutro } from './prompts.js'
import { dockerCompose } from './process.js'
import { removeTimer } from './systemd.js'
import type { UserContext } from './types.js'

export async function uninstall(root: string, user: UserContext): Promise<void> {
  assertDeployment(root)
  const files = deploymentFiles(root)
  promptNote(
    `This stops and removes ghark's containers and network, automatic backup timer, and managed command launcher.\n\nRemote restic backups in S3 or R2 are never deleted. Run ghark backup start first if you want a final snapshot.`,
    'Uninstall ghark'
  )
  if (!await promptConfirm('Continue with uninstall?', false)) {
    promptOutro('Uninstall cancelled. Nothing was changed.')
    return
  }

  const removeLocalData = await promptConfirm(
    `Also permanently delete ${root}, including mirrored repositories, credentials, and local configuration?`,
    false
  )

  await withOperationLock(files.lock, 'uninstall', async () => {
    removeTimer(true)
    dockerCompose(root, ['down', '--remove-orphans'])
    removePinnedCli(root, user)
    rmSync(files.cli, { recursive: true, force: true })
    rmSync(files.systemd, { recursive: true, force: true })
    if (removeLocalData) rmSync(root, { recursive: true, force: true })
  })

  if (removeLocalData) {
    promptOutro(`Ghark and its local data were removed. Remote S3/R2 backups were kept.`)
  } else {
    promptOutro(`Ghark was uninstalled. Local data remains at ${root}; run npx @marciclabas/ghark init to reinstall it.`)
  }
}
