import image15 from '../assets/character-avatars/albert-einstein.png?inline'
import image27 from '../assets/character-avatars/american-gothic-farmer.png?inline'
import image7 from '../assets/character-avatars/andy-warhol.png?inline'
import image13 from '../assets/character-avatars/beethoven.png?inline'
import image17 from '../assets/character-avatars/charlie-chaplin.png?inline'
import image12 from '../assets/character-avatars/claude-monet.png?inline'
import image21 from '../assets/character-avatars/cleopatra.png?inline'
import image30 from '../assets/character-avatars/david.png?inline'
import image23 from '../assets/character-avatars/dunhuang-apsara.png?inline'
import image20 from '../assets/character-avatars/elizabeth-i.png?inline'
import image28 from '../assets/character-avatars/flower-wreath-portrait.png?inline'
import image5 from '../assets/character-avatars/frida-kahlo.png?inline'
import image18 from '../assets/character-avatars/holly-golightly.png?inline'
import image16 from '../assets/character-avatars/isaac-newton.png?inline'
import image25 from '../assets/character-avatars/lady-with-ermine.png?inline'
import image11 from '../assets/character-avatars/leonardo-da-vinci.png?inline'
import image19 from '../assets/character-avatars/marilyn-monroe.png?inline'
import image3 from '../assets/character-avatars/mona-lisa.png?inline'
import image14 from '../assets/character-avatars/mozart.png?inline'
import image1 from '../assets/character-avatars/napoleon.png?inline'
import image2 from '../assets/character-avatars/pearl-girl.png?inline'
import image10 from '../assets/character-avatars/rembrandt.png?inline'
import image6 from '../assets/character-avatars/salvador-dali.png?inline'
import image9 from '../assets/character-avatars/son-of-man.png?inline'
import image26 from '../assets/character-avatars/the-scream.png?inline'
import image22 from '../assets/character-avatars/tutankhamun.png?inline'
import image4 from '../assets/character-avatars/van-gogh.png?inline'
import image24 from '../assets/character-avatars/venus.png?inline'
import image29 from '../assets/character-avatars/william-shakespeare.png?inline'
import image8 from '../assets/character-avatars/yayoi-kusama.png?inline'

export interface CharacterAvatar {
  id: string
  image: string
  en: string
  zh: string
}

/** Approved 64px transparent PNGs, in review order. Inline URLs also work in
 * profiles.set_asset on remote backends and survive future bundle hashes. */
export const CHARACTER_AVATARS: readonly CharacterAvatar[] = [
  { id: 'napoleon', image: image1, en: 'Napoleon', zh: '拿破仑' },
  { id: 'pearl-girl', image: image2, en: 'Pearl Girl', zh: '戴珍珠耳环的少女' },
  { id: 'mona-lisa', image: image3, en: 'Mona Lisa', zh: '蒙娜丽莎' },
  { id: 'van-gogh', image: image4, en: 'Van Gogh', zh: '梵高' },
  { id: 'frida-kahlo', image: image5, en: 'Frida Kahlo', zh: '弗里达·卡罗' },
  { id: 'salvador-dali', image: image6, en: 'Salvador Dali', zh: '萨尔瓦多·达利' },
  { id: 'andy-warhol', image: image7, en: 'Andy Warhol', zh: '安迪·沃霍尔' },
  { id: 'yayoi-kusama', image: image8, en: 'Yayoi Kusama', zh: '草间弥生' },
  { id: 'son-of-man', image: image9, en: 'Son Of Man', zh: '人类之子' },
  { id: 'rembrandt', image: image10, en: 'Rembrandt', zh: '伦勃朗' },
  { id: 'leonardo-da-vinci', image: image11, en: 'Leonardo Da Vinci', zh: '列奥纳多·达·芬奇' },
  { id: 'claude-monet', image: image12, en: 'Claude Monet', zh: '克劳德·莫奈' },
  { id: 'beethoven', image: image13, en: 'Beethoven', zh: '贝多芬' },
  { id: 'mozart', image: image14, en: 'Mozart', zh: '莫扎特' },
  { id: 'albert-einstein', image: image15, en: 'Albert Einstein', zh: '阿尔伯特·爱因斯坦' },
  { id: 'isaac-newton', image: image16, en: 'Isaac Newton', zh: '艾萨克·牛顿' },
  { id: 'charlie-chaplin', image: image17, en: 'Charlie Chaplin', zh: '查理·卓别林' },
  { id: 'holly-golightly', image: image18, en: 'Holly Golightly', zh: '霍莉·戈莱特利' },
  { id: 'marilyn-monroe', image: image19, en: 'Marilyn Monroe', zh: '玛丽莲·梦露' },
  { id: 'elizabeth-i', image: image20, en: 'Elizabeth I', zh: '伊丽莎白一世' },
  { id: 'cleopatra', image: image21, en: 'Cleopatra', zh: '克娄巴特拉' },
  { id: 'tutankhamun', image: image22, en: 'Tutankhamun', zh: '图坦卡蒙' },
  { id: 'dunhuang-apsara', image: image23, en: 'Dunhuang Apsara', zh: '敦煌飞天' },
  { id: 'venus', image: image24, en: 'Venus', zh: '维纳斯' },
  { id: 'lady-with-ermine', image: image25, en: 'Lady With Ermine', zh: '抱银貂的女子' },
  { id: 'the-scream', image: image26, en: 'The Scream', zh: '呐喊' },
  { id: 'american-gothic-farmer', image: image27, en: 'American Gothic Farmer', zh: '美国哥特式农夫' },
  { id: 'flower-wreath-portrait', image: image28, en: 'Woman with a Floral Hat', zh: '戴花环的女子' },
  { id: 'william-shakespeare', image: image29, en: 'William Shakespeare', zh: '威廉·莎士比亚' },
  { id: 'david', image: image30, en: 'David', zh: '大卫' }
]

export function defaultCharacterAvatar(name: string): CharacterAvatar {
  let hash = 0

  for (const ch of name) {
    hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0
  }

  return CHARACTER_AVATARS[hash % CHARACTER_AVATARS.length]
}

/** The roster backfill draws the live SVG at 160x160. Pets are 96x104
 *  and uploads are 256. Use that to tell a still face-copy from a real picture. */
export function isBackfilledFacePng(dataUrl: null | string | undefined) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return false
  }

  try {
    const bin = atob(dataUrl.slice('data:image/png;base64,'.length).slice(0, 48))

    if (bin.length < 24) {
      return false
    }

    const w = (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)
    const h = (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)

    return w === 160 && h === 160
  } catch {
    return false
  }
}

/** Explicit uploaded/generated/pet/catalog art always wins; reset is render-only. */
export function resolveCharacterAvatar(name: string, image?: null | string): string {
  return image || defaultCharacterAvatar(name).image
}
