/**
 * A short, well-known verse for “Today’s verse” on the Feed. The pick is
 * deterministic by UTC date so every visitor sees the same one that day.
 * Text here is a fallback; the rails route prefers a live Books API passage.
 */
'use strict';

const DAILY = [
  { ref: 'Psalm 23:1', text: 'The LORD is my shepherd; I shall not want.' },
  { ref: 'John 3:16', text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.' },
  { ref: 'Romans 8:28', text: 'And we know that all things work together for good to them that love God, to them who are the called according to his purpose.' },
  { ref: 'Philippians 4:6-7', text: 'Be careful for nothing; but in every thing by prayer and supplication with thanksgiving let your requests be made known unto God.' },
  { ref: 'Isaiah 41:10', text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God.' },
  { ref: 'Matthew 11:28', text: 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.' },
  { ref: 'Joshua 1:9', text: 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.' },
  { ref: 'Psalm 46:1', text: 'God is our refuge and strength, a very present help in trouble.' },
  { ref: 'Proverbs 3:5-6', text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding.' },
  { ref: 'Jeremiah 29:11', text: 'For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.' },
  { ref: 'Psalm 121:1-2', text: 'I will lift up mine eyes unto the hills, from whence cometh my help. My help cometh from the LORD, which made heaven and earth.' },
  { ref: 'John 14:27', text: 'Peace I leave with you, my peace I give unto you: not as the world giveth, give I unto you.' },
  { ref: 'Isaiah 40:31', text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.' },
  { ref: 'Psalm 27:1', text: 'The LORD is my light and my salvation; whom shall I fear?' },
  { ref: 'Matthew 5:9', text: 'Blessed are the peacemakers: for they shall be called the children of God.' },
  { ref: 'Romans 15:13', text: 'Now the God of hope fill you with all joy and peace in believing.' },
  { ref: 'Psalm 19:14', text: 'Let the words of my mouth, and the meditation of my heart, be acceptable in thy sight, O LORD.' },
  { ref: '1 Corinthians 13:13', text: 'And now abideth faith, hope, charity, these three; but the greatest of these is charity.' },
  { ref: 'Micah 6:8', text: 'What doth the LORD require of thee, but to do justly, and to love mercy, and to walk humbly with thy God?' },
  { ref: 'Psalm 34:8', text: 'O taste and see that the LORD is good: blessed is the man that trusteth in him.' },
  { ref: 'Hebrews 11:1', text: 'Now faith is the substance of things hoped for, the evidence of things not seen.' },
  { ref: 'Psalm 118:24', text: 'This is the day which the LORD hath made; we will rejoice and be glad in it.' },
  { ref: 'John 1:5', text: 'And the light shineth in darkness; and the darkness comprehended it not.' },
  { ref: 'Galatians 6:9', text: 'And let us not be weary in well doing: for in due season we shall reap, if we faint not.' },
  { ref: 'Psalm 37:5', text: 'Commit thy way unto the LORD; trust also in him; and he shall bring it to pass.' },
  { ref: 'Matthew 6:33', text: 'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.' },
  { ref: 'Psalm 51:10', text: 'Create in me a clean heart, O God; and renew a right spirit within me.' },
  { ref: 'Romans 12:12', text: 'Rejoicing in hope; patient in tribulation; continuing instant in prayer.' },
  { ref: 'Isaiah 26:3', text: 'Thou wilt keep him in perfect peace, whose mind is stayed on thee: because he trusteth in thee.' },
  { ref: 'Psalm 90:17', text: 'And let the beauty of the LORD our God be upon us: and establish thou the work of our hands upon us.' },
  { ref: 'John 8:12', text: 'I am the light of the world: he that followeth me shall not walk in darkness, but shall have the light of life.' },
];

function dayOfYear(now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  const start = Date.UTC(t.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - start) / 86400000);
}

function verseOfTheDay(now = new Date()) {
  const i = ((dayOfYear(now) % DAILY.length) + DAILY.length) % DAILY.length;
  const v = DAILY[i];
  return { ...v, href: '/books?ref=' + encodeURIComponent(v.ref) };
}

module.exports = { DAILY, dayOfYear, verseOfTheDay };
