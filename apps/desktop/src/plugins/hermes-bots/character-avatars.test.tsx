import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line no-restricted-imports -- test uses the real catalog while mocking the SDK host boundary
import { CHARACTER_AVATARS, characterAvatarSources, defaultCharacterAvatar } from '@/lib/character-avatars'

vi.mock('@hermes/plugin-sdk', async () => {
  const { atom } = await import('nanostores')

  return {
    atom,
    CHARACTER_AVATARS,
    defaultCharacterAvatar,
    characterAvatarSources,
    profileColor: () => '#8b5cf6',
    useI18n: () => ({ locale: 'zh' }),
    useValue: (store: { get: () => unknown }) => store.get(),
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
    host: { request: vi.fn(), state: { connectionId: { get: () => 'local' } } },
    Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
    RowButton: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
    SegmentedControl: () => null,
    Codicon: () => null,
    GlyphSpinner: () => null,
    Textarea: () => null,
    blobatarSvg: undefined,
    createBudgetedLoop: undefined,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipContent: () => null,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => children
  }
})
vi.mock('./avatar-image', () => ({
  $imagenAvailable: { get: () => false },
  probeImagen: vi.fn(),
  generateAvatarImage: vi.fn(),
  normalizeAvatarImage: vi.fn(),
  pickImageFromDevice: vi.fn()
}))
vi.mock('./i18n', () => ({
  useBots: () => ({
    avatar: { tabBot: '人物', removeImage: '恢复默认', tabGenerate: '生成', upload: '上传', tabPet: '宠物' }
  })
}))
vi.mock('./pet', () => ({ PetTab: () => null }))

import { botAppearance, BotFace } from './avatar'
import { AvatarPicker } from './avatar-picker'

afterEach(cleanup)

describe('shared bot character art', () => {
  it('uses native-size display art in BotFace and picker without changing persisted picks', () => {
    for (const size of [16, 22, 32, 36, 40, 48, 64, 80, 256, 300, 512]) {
      const image = CHARACTER_AVATARS[0].image
      const { container, unmount } = render(<BotFace color="#aaa" image={image} name="other" shape="character" size={size} />)
      const img = container.querySelector('img')!
      const sources = characterAvatarSources('other', image, size)
      expect(img.getAttribute('src')).toBe(sources.src)
      expect(img.getAttribute('srcset')).toBe(sources.srcSet)
      expect(img.getAttribute('sizes')).toBe(`${size}px`)
      expect(img.style.width).toBe(`${size}px`)
      unmount()
    }

    const { container } = render(<AvatarPicker color={null} image={null} onColor={() => {}} onImage={() => {}} onShape={() => {}} shape="character" />)

    for (const [index, img] of [...container.querySelectorAll('[data-character-avatar] img')].entries()) {
      expect(img.getAttribute('sizes')).toBe('40px')
      expect(img.getAttribute('srcset')).toBe(characterAvatarSources('', CHARACTER_AVATARS[index].image, 40).srcSet)
    }
  })
  it('replaces legacy appearances with stable art while keeping custom images', () => {
    for (const name of ['default', 'scout']) {
      for (const meta of [undefined, { shape: 'blobatar' }, { shape: 'triangle', custom: true }]) {
        const look = botAppearance(name, meta)
        const { container, unmount } = render(<BotFace {...look} color="#aaa" name={name} />)
        expect(container.querySelector('img')?.getAttribute('src')).toBe(characterAvatarSources(name, null, 36).src)
        expect(container.querySelector('svg')).toBeNull()
        unmount()
      }
    }

    const image = 'data:image/png;base64,custom'
    expect(botAppearance('default', { image }).image).toBe(image)
  })

  it('offers every catalog image, selects portable art, and resets without touching color', () => {
    const onImage = vi.fn(),
      onColor = vi.fn(),
      onShape = vi.fn()

    const { container, rerender } = render(
      <AvatarPicker color={null} image={null} onColor={onColor} onImage={onImage} onShape={onShape} shape="blobatar" />
    )

    const choices = container.querySelectorAll('[data-character-avatar]')
    expect(choices).toHaveLength(CHARACTER_AVATARS.length)

    for (const [index, button] of [...choices].entries()) {
      fireEvent.click(button)
      expect(onImage).toHaveBeenLastCalledWith(CHARACTER_AVATARS[index].image)
    }

    expect(onColor).not.toHaveBeenCalled()
    rerender(
      <AvatarPicker
        color={null}
        image={CHARACTER_AVATARS[0].image}
        onColor={onColor}
        onImage={onImage}
        onShape={onShape}
        shape="character"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(onImage).toHaveBeenLastCalledWith(null)
  })
})
