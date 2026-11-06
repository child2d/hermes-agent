/**
 * The avatar editor shared by Edit Profile and New Bot: character portraits,
 * the Generate and Upload tabs, and the petdex Pet tab.
 */

import {
  Button,
  CHARACTER_AVATARS,
  cn,
  Codicon,
  defaultCharacterAvatar,
  GlyphSpinner,
  host,
  RowButton,
  SegmentedControl,
  Textarea,
  useI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import {
  $imagenAvailable,
  generateAvatarImage,
  type GeneratedImage,
  normalizeAvatarImage,
  pickImageFromDevice,
  probeImagen
} from './avatar-image'
import { useBots } from './i18n'
import { PetTab } from './pet'

interface AvatarPickerProps {
  /** `null` = no explicit pick, i.e. the name's deterministic hue. */
  color: null | string
  /** Feeds the Generate tab when the user leaves the description blank. */
  generateSeed?: { description?: string; name?: string; title?: string } | null
  image: null | string
  onColor: (color: null | string) => void
  onImage: (image: null | string) => void
  onShape: (shape: string) => void
  shape: string
}

/** Approved character portraits, shared by Edit Profile and New Bot. */
export function AvatarPicker({ image, onShape, onImage, generateSeed }: AvatarPickerProps) {
  const { locale } = useI18n()
  const b = useBots()
  const pickerName = generateSeed?.name || 'agent'
  const imagen = useValue($imagenAvailable)
  const [tab, setTab] = useState('bot')
  const [describe, setDescribe] = useState('')
  const [genBusy, setGenBusy] = useState(false)

  if (imagen === null) {
    void probeImagen()
  }

  // Re-check a stale "unavailable" whenever the user lands on the Generate
  // tab — the gateway may have restarted with image.generate since.
  const goTab = (id: string) => {
    setTab(id)

    if (id === 'generate' && $imagenAvailable.get() === false) {
      $imagenAvailable.set(null)
      void probeImagen()
    }
  }

  const upload = async () => {
    const raw = await pickImageFromDevice()

    if (raw) {
      onImage(await normalizeAvatarImage(raw))
    }
  }

  const generate = async () => {
    if (genBusy) {
      return
    }

    setGenBusy(true)

    try {
      const custom = describe.trim()

      const img = custom
        ? await (async () => {
            const res = await host.request<GeneratedImage>('image.generate', {
              prompt: `${custom}. Avatar for an AI agent: centered, bold flat vector style, solid color background, no text.`,
              aspect_ratio: 'square'
            })

            if (!res?.success) {
              throw new Error(res?.error || 'generation failed')
            }

            return res.image_data || res.image
          })()
        : await generateAvatarImage(generateSeed?.name || 'agent', generateSeed?.title, generateSeed?.description)

      if (img) {
        onImage(await normalizeAvatarImage(img))
      }
    } catch (err) {
      host.notifyError(err, b.avatar.generationFailed)
    } finally {
      setGenBusy(false)
    }
  }

  return (
    <div className="grid justify-items-center gap-3">
      <SegmentedControl
        onChange={goTab}
        options={[
          { id: 'bot', label: b.avatar.tabBot },
          { id: 'generate', label: b.avatar.tabGenerate },
          { id: 'upload', label: b.avatar.upload },
          { id: 'pet', label: b.avatar.tabPet }
        ]}
        value={tab}
      />
      {image && tab !== 'generate' ? (
        <Button
          onClick={() => {
            onShape('character')
            onImage(null)
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {b.avatar.removeImage}
        </Button>
      ) : null}
      {tab === 'bot' ? (
        <div className="grid grid-cols-6 justify-items-center gap-1.5" data-testid="character-avatar-picker">
          {CHARACTER_AVATARS.map(avatar => (
            <RowButton
              aria-label={locale.startsWith('zh') ? avatar.zh : avatar.en}
              aria-pressed={image === avatar.image || (!image && defaultCharacterAvatar(pickerName).id === avatar.id)}
              className={cn(
                'flex size-11 items-center justify-center rounded-md transition-colors hover:bg-(--chrome-action-hover)',
                (image === avatar.image || (!image && defaultCharacterAvatar(pickerName).id === avatar.id)) &&
                  'ring-1 ring-(--ui-accent)'
              )}
              data-character-avatar={avatar.id}
              key={avatar.id}
              onClick={() => {
                onShape('character')
                onImage(avatar.image)
              }}
              type="button"
            >
              <img alt="" className="size-10 object-contain" height={40} src={avatar.image} width={40} />
            </RowButton>
          ))}
        </div>
      ) : null}
      {tab === 'generate' ? (
        imagen ? (
          <div className="grid w-full gap-2">
            <Textarea
              className="min-h-16 text-xs"
              onChange={event => setDescribe(event.target.value)}
              placeholder={b.avatar.describePlaceholder}
              value={describe}
            />
            <Button
              className="w-full justify-center"
              disabled={genBusy}
              onClick={generate}
              type="button"
              variant="secondary"
            >
              {genBusy ? (
                <GlyphSpinner className="mr-1 text-sm" spinner="breathe" />
              ) : (
                <Codicon className="mr-1 text-sm" name="sparkle" />
              )}
              {genBusy ? b.avatar.generating : b.avatar.generate}
            </Button>
            {describe.trim() ? null : (
              <div className="text-center text-2xs text-(--ui-text-quaternary)">{b.bot.descriptionHint}</div>
            )}
          </div>
        ) : (
          <div className="px-2 py-3 text-center text-xs leading-5 text-(--ui-text-tertiary)">
            {imagen === false ? b.editor.noImageModel : b.editor.checkingImage}
          </div>
        )
      ) : null}
      {tab === 'upload' ? (
        <Button className="w-full justify-center" onClick={upload} type="button" variant="secondary">
          <Codicon className="mr-1 text-sm" name="device-camera" />
          {b.editor.chooseImage}
        </Button>
      ) : null}
      {tab === 'pet' ? <PetTab image={image} onImage={onImage} /> : null}
    </div>
  )
}
