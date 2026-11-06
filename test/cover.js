/* Обложки из файлов: ID3v2.2–2.4, FLAC, M4A — на синтетических байтах. */
'use strict';
const C = require(require('path').join(__dirname, '..', 'extension', 'src', 'cover.js'));
const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,5,0xff,0xd9]);
const png = Buffer.from([0x89,0x50,0x4e,0x47,9,9,9]);
const be32 = n => { const b=Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const ss = n => Buffer.from([(n>>21)&127,(n>>14)&127,(n>>7)&127,n&127]);
let ok=0, bad=0; const t=(n,c)=>{c?ok++:bad++; console.log((c?'OK  ':'FAIL'), n);};
// ID3v2.3: TIT2 + APIC(other) + APIC(front)
function frame3(id, body){ return Buffer.concat([Buffer.from(id), be32(body.length), Buffer.from([0,0]), body]); }
const apic = (type, img, enc=0, desc='') => Buffer.concat([Buffer.from([enc]), Buffer.from('image/jpeg\0'), Buffer.from([type]),
  enc===1 ? Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(desc,'utf16le'), Buffer.from([0,0])]) : Buffer.from(desc+'\0'), img]);
const frames = Buffer.concat([frame3('TIT2', Buffer.from('\0Song')), frame3('APIC', apic(0, png)), frame3('APIC', apic(3, jpg, 1, 'Обл'))]);
const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3,0,0]), ss(frames.length+20), frames, Buffer.alloc(20), Buffer.from('MP3DATA')]);
let r = C.extract(id3); t('ID3v2.3: лицевая обложка', r && r.type===3 && Buffer.from(r.bytes).equals(jpg) && r.mime==='image/jpeg');
// ID3v2.4 syncsafe frame size
function frame4(id, body){ return Buffer.concat([Buffer.from(id), ss(body.length), Buffer.from([0,0]), body]); }
const f4 = frame4('APIC', apic(3, png));
r = C.extract(Buffer.concat([Buffer.from('ID3'), Buffer.from([4,0,0]), ss(f4.length), f4]));
t('ID3v2.4: png, mime по сигнатуре', r && r.mime==='image/png' && Buffer.from(r.bytes).equals(png));
// ID3v2.2 PIC
const pic22 = Buffer.concat([Buffer.from([0]), Buffer.from('JPG'), Buffer.from([3]), Buffer.from('\0'), jpg]);
const f2 = Buffer.concat([Buffer.from('PIC'), Buffer.from([0,0,pic22.length]), pic22]);
r = C.extract(Buffer.concat([Buffer.from('ID3'), Buffer.from([2,0,0]), ss(f2.length), f2]));
t('ID3v2.2: PIC', r && Buffer.from(r.bytes).equals(jpg));
// FLAC
const pblock = Buffer.concat([be32(3), be32(10), Buffer.from('image/jpeg'), be32(0), be32(1),be32(1),be32(24),be32(0), be32(jpg.length), jpg]);
const si = Buffer.alloc(34);
const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0, 0,0,34]), si, Buffer.from([0x80|6, (pblock.length>>16)&255,(pblock.length>>8)&255,pblock.length&255]), pblock]);
r = C.extract(flac); t('FLAC: PICTURE', r && Buffer.from(r.bytes).equals(jpg));
// MP4
const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([be32(body.length+8), Buffer.from(type), body]); };
const data = box('data', be32(13), be32(0), png);
const mp4 = Buffer.concat([box('ftyp', Buffer.from('M4A '), be32(0)), box('mdat', Buffer.alloc(16)),
  box('moov', box('mvhd', Buffer.alloc(8)), box('udta', box('meta', be32(0), box('hdlr', Buffer.alloc(8)), box('ilst', Buffer.concat([be32(12), Buffer.from([0xa9]), Buffer.from('nam'), Buffer.alloc(4)]), box('covr', data)))))]);
r = C.extract(mp4); t('M4A: covr', r && Buffer.from(r.bytes).equals(png) && r.mime==='image/png');
// без обложки и мусор
t('mp3 без обложки → null', C.extract(Buffer.concat([Buffer.from('ID3'), Buffer.from([3,0,0]), ss(10), Buffer.alloc(10)])) === null);
t('мусор → null', C.extract(Buffer.from('просто байты')) === null);
t('обрезанный тег не падает', C.extract(id3.subarray(0, 40)) === null || true);
// ---- теги
const iconv1251 = (str) => Buffer.from([...str].map((ch) => { const c = ch.charCodeAt(0);
  if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0; if (c === 0x401) return 0xa8; if (c === 0x451) return 0xb8; return c; }));
const txt3 = (id, enc, bytes) => frame3(id, Buffer.concat([Buffer.from([enc]), bytes]));
const tagV3 = (frames) => Buffer.concat([Buffer.from('ID3'), Buffer.from([3,0,0]), ss(frames.length), frames]);
r = C.tagsOf(tagV3(Buffer.concat([txt3('TPE1', 0, iconv1251('МУККА')), txt3('TIT2', 0, iconv1251('Таблетка'))])));
t('ID3v2.3: русский текст в CP1251', r && r.artist === 'МУККА' && r.title === 'Таблетка', JSON.stringify(r));
const u16 = (str) => Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(str, 'utf16le'), Buffer.from([0,0])]);
r = C.tagsOf(tagV3(Buffer.concat([txt3('TPE1', 1, u16('Пошлая Молли')), txt3('TIT2', 1, u16('Ханнамонтана'))])));
t('ID3v2.3: UTF-16', r && r.artist === 'Пошлая Молли' && r.title === 'Ханнамонтана', JSON.stringify(r));
const f4t = Buffer.concat([frame4('TPE1', Buffer.concat([Buffer.from([3]), Buffer.from('Face\0Kid', 'utf8')])), frame4('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('Мой Калашников', 'utf8')]))]);
r = C.tagsOf(Buffer.concat([Buffer.from('ID3'), Buffer.from([4,0,0]), ss(f4t.length), f4t]));
t('ID3v2.4: UTF-8, несколько исполнителей', r && r.artist === 'Face, Kid' && r.title === 'Мой Калашников', JSON.stringify(r));
const le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const vc = (kv) => Buffer.concat([le(Buffer.byteLength(kv)), Buffer.from(kv)]);
const vblock = Buffer.concat([le(3), Buffer.from('ref'), le(3), vc('ARTIST=МУККА'), vc('title=Таблетка'), vc('ALBUM=X')]);
r = C.tagsOf(Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80|4, (vblock.length>>16)&255, (vblock.length>>8)&255, vblock.length&255]), vblock]));
t('FLAC: Vorbis comments', r && r.artist === 'МУККА' && r.title === 'Таблетка', JSON.stringify(r));
const dataAtom = (str) => box('data', be32(1), be32(0), Buffer.from(str, 'utf8'));
const tagBox = (type, str) => { const body = dataAtom(str); return Buffer.concat([be32(body.length + 8), Buffer.from([0xa9]), Buffer.from(type), body]); };
const m4a = Buffer.concat([box('ftyp', Buffer.from('M4A '), be32(0)),
  box('moov', box('udta', box('meta', be32(0), box('ilst', tagBox('nam', 'Таблетка'), tagBox('ART', 'МУККА')))))]);
r = C.tagsOf(m4a); t('M4A: ©nam / ©ART', r && r.artist === 'МУККА' && r.title === 'Таблетка', JSON.stringify(r));
const v1 = Buffer.alloc(128); Buffer.from('TAG').copy(v1, 0); iconv1251('Таблетка').copy(v1, 3); iconv1251('МУККА').copy(v1, 33);
r = C.tagsOf(Buffer.concat([Buffer.from('MP3DATA....'), v1]));
t('ID3v1 в конце файла, CP1251', r && r.artist === 'МУККА' && r.title === 'Таблетка', JSON.stringify(r));
t('файл без тегов → null', C.tagsOf(Buffer.from('просто байты без тегов')) === null);

console.log(bad ? 'ПРОВАЛОВ: '+bad : 'Все проверки пройдены');
process.exit(bad?1:0);
