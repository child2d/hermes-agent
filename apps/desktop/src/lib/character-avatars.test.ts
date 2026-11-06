import { describe, expect, it } from 'vitest'

import { CHARACTER_AVATARS, defaultCharacterAvatar, resolveCharacterAvatar } from './character-avatars'

describe('character avatars', () => {
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
