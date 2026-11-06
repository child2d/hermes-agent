import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'

import { characterAvatarSources, isBackfilledFacePng } from '@/lib/character-avatars'
import { queryClient } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { $gateway, requestGatewayForAgent } from '@/store/gateway'
import { $connection } from '@/store/session'

interface ProfileAvatarAsset {
  found?: boolean
  data?: string
}

/** Bot and Profile surfaces read the same profile asset, never a renderer-only
 * selection id. The source is part of the cache key: same-name remote profiles
 * must not borrow art from this device. Read assets through the source's default
 * backend, not one newly spawned backend per profile in a rail. */
export function ProfileGlyph({
  className,
  color: _color,
  isDefault: _isDefault,
  connectionId,
  name,
  size = 16,
  ...props
}: Omit<React.ComponentProps<'span'>, 'color'> & {
  color: null | string
  connectionId?: null | string
  isDefault: boolean
  name: string
  /** CSS display width; keep in sync when className overrides size-4. */
  size?: number
}) {
  const gateway = useStore($gateway)
  const connection = useStore($connection)
  const source = connectionId || connection?.connectionId || connection?.baseUrl || ''
  const remote = Boolean(connectionId && connectionId !== connection?.connectionId)

  const { data } = useQuery<ProfileAvatarAsset>(
    {
      queryKey: ['profile-avatar', source, name],
      enabled: Boolean(name && (remote || gateway)),
      queryFn: async () => {
        const request = <T,>(method: string, params: Record<string, unknown>) =>
          remote
            ? requestGatewayForAgent<T>(connectionId!, 'default', method, params)
            : gateway!.request<T>(method, params)

        const asset = await request<ProfileAvatarAsset>('profiles.get_asset', { name, asset: 'avatar' })

        if (!isBackfilledFacePng(asset.data)) {
          return asset
        }

        // Old desktops wrote a 160px copy of their geometric face as an asset.
        // Consult its provenance before replacing it: a real uploaded picture
        // can have exactly the same dimensions. Cache the list per source.
        const roster = await queryClient.fetchQuery({
          queryKey: ['profile-avatar-provenance', source],
          queryFn: () =>
            request<{
              profiles?: Array<{ name: string; ui_meta?: Record<string, { imageKind?: string; pet?: unknown }> }>
            }>('profiles.list', {})
        })

        const meta = roster.profiles?.find(profile => profile.name === name)?.ui_meta?.['hermes-bots']

        return meta?.imageKind === 'photo' || meta?.pet ? asset : { found: false }
      },
      retry: false
    },
    queryClient
  )

  return (
    <span className={cn('grid size-4 shrink-0 place-items-center', className)} {...props}>
      <img
        alt=""
        className="size-full object-contain"
        {...characterAvatarSources(name, data?.found ? data.data : null, size)}
      />
    </span>
  )
}
