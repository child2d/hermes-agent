import { describe, expect, it } from 'vitest'

import { CHARACTER_AVATARS, characterAvatarSources, defaultCharacterAvatar, resolveCharacterAvatar } from './character-avatars'

describe('character avatars', () => {
  it('upgrades every persisted catalog identity to size-appropriate art with Retina candidates', () => {
    for (const avatar of CHARACTER_AVATARS) {
      for (const [size, suffix] of [[16, '-32.png'], [32, '-32.png'], [40, '.png'], [64, '.png'], [65, '-256.webp'], [256, '-256.webp'], [300, '-512.webp']] as const) {
        const sources = characterAvatarSources('another-name', avatar.image, size)

        if (size === 40 || size === 64) {expect(sources.src).toBe(avatar.image)}
        else {expect(sources.src).toContain(avatar.id + suffix)}

        expect(sources.sizes).toBe(`${size}px`)
        expect(sources.srcSet).toContain(' 32w, ')
        expect(sources.srcSet).toContain(' 64w, ')
        expect(sources.srcSet).toContain(`${avatar.id}-256.webp`)
        expect(sources.srcSet).toContain(`${avatar.id}-512.webp`)
      }
    }
  })
  it('keeps defaults synchronized at every size and never substitutes custom photos or pets', () => {
    for (const name of ['default', '研究助手', 'scout', '']) {
      for (const size of [12, 14, 16, 22, 32, 40, 48, 64, 80, 256, 512]) {
        expect(characterAvatarSources(name, null, size)).toEqual(
          characterAvatarSources('unrelated', defaultCharacterAvatar(name).image, size)
        )
      }
    }

    for (const size of [64, 160, 256]) {
      // A valid PNG header of the same dimensions is NOT a catalog identity.
      const header = new Uint8Array(24)
      new DataView(header.buffer).setUint32(16, size)
      new DataView(header.buffer).setUint32(20, size)
      const custom = `data:image/png;base64,${btoa(String.fromCharCode(...header))}`
      expect(characterAvatarSources('agent', custom, 512)).toEqual({ src: custom, srcSet: undefined, sizes: undefined })
    }

    for (const image of ['https://example.test/photo.png', 'data:image/webp;base64,pet']) {
      expect(characterAvatarSources('agent', image, 16).src).toBe(image)
      expect(characterAvatarSources('agent', image, 16).srcSet).toBeUndefined()
    }
  })

  it('resolves portable PNG picks and stable defaults without replacing custom images', () => {
    for (const avatar of CHARACTER_AVATARS) {
      expect(avatar.image).toMatch(/^data:image\/png;base64,/)
      expect(resolveCharacterAvatar('agent', avatar.image)).toBe(avatar.image)
    }

    expect(new Set(CHARACTER_AVATARS.map(avatar => avatar.id)).size).toBe(CHARACTER_AVATARS.length)

    for (const name of ['default', '研究助手', 'scout', '']) {
      expect(resolveCharacterAvatar(name, null)).toBe(defaultCharacterAvatar(name).image)
      expect(defaultCharacterAvatar(name)).toBe(defaultCharacterAvatar(name))
      expect(CHARACTER_AVATARS).toContain(defaultCharacterAvatar(name))
    }

    expect(resolveCharacterAvatar('agent', 'data:image/png;base64,custom')).toBe('data:image/png;base64,custom')
  })
})
