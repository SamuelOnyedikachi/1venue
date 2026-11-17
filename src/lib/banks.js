/**
 * Nigerian banks for payout details, and a best-effort parser for the old one-box "bank, number, name" text.
 * Names are what hosts pick in Earnings; aliases only help the parser recognise older free text.
 */
const BANKS = [
  ['Access Bank', ['access bank', 'access', 'diamond bank', 'access diamond']], ['Citibank Nigeria', ['citibank', 'citi']], ['Ecobank Nigeria', ['ecobank', 'eco bank']],
  ['Fidelity Bank', ['fidelity']], ['First Bank of Nigeria', ['first bank', 'firstbank', 'fbn']], ['First City Monument Bank (FCMB)', ['fcmb', 'first city monument']],
  ['Globus Bank', ['globus']], ['Guaranty Trust Bank (GTBank)', ['gtbank', 'gt bank', 'gtb', 'guaranty trust', 'gtco']], ['Heritage Bank', ['heritage']],
  ['Jaiz Bank', ['jaiz']], ['Keystone Bank', ['keystone']], ['Kuda Microfinance Bank', ['kuda']], ['Lotus Bank', ['lotus']],
  ['Moniepoint Microfinance Bank', ['moniepoint']], ['OPay', ['opay', 'o-pay']], ['Optimus Bank', ['optimus']], ['PalmPay', ['palmpay', 'palm pay']],
  ['Parallex Bank', ['parallex']], ['Polaris Bank', ['polaris', 'skye bank']], ['PremiumTrust Bank', ['premiumtrust', 'premium trust']], ['Providus Bank', ['providus']],
  ['Signature Bank', ['signature bank']], ['Stanbic IBTC Bank', ['stanbic', 'ibtc']], ['Standard Chartered Bank', ['standard chartered', 'stanchart']],
  ['Sterling Bank', ['sterling']], ['SunTrust Bank', ['suntrust', 'sun trust']], ['TAJBank', ['tajbank', 'taj bank']], ['Titan Trust Bank', ['titan trust', 'titan']],
  ['Union Bank of Nigeria', ['union bank', 'unionbank']], ['United Bank for Africa (UBA)', ['uba', 'united bank for africa']], ['Unity Bank', ['unity bank', 'unity']],
  ['VFD Microfinance Bank', ['vfd']], ['Wema Bank', ['wema', 'alat']], ['Zenith Bank', ['zenith']], ['Carbon', ['carbon']], ['FairMoney Microfinance Bank', ['fairmoney', 'fair money']],
  ['Paga', ['paga']], ['Rubies Microfinance Bank', ['rubies']], ['Sparkle Microfinance Bank', ['sparkle']], ['9PSB (9mobile)', ['9psb', '9 psb', '9mobile']],
  ['MoMo PSB (MTN)', ['momo psb', 'momo', 'mtn momo']], ['SmartCash PSB (Airtel)', ['smartcash', 'smart cash']],
];
const NAMES = BANKS.map(([n]) => n);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIASES = BANKS.flatMap(([n, a]) => [n.toLowerCase(), ...a].map((x) => [x, n])).sort((x, y) => y[0].length - x[0].length);

/** Pure: split old free text like "GTB 0123456789 Ada Obi" into { bankName, accountNumber, accountName, complete }. */
function parseBankText(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { bankName: null, accountNumber: null, accountName: null, complete: false };
  let accountNumber = null;
  const num = t.replace(/(\d)[\s-](?=\d)/g, '$1').match(/(?:^|\D)(\d{10})(?!\d)/);
  if (num) { accountNumber = num[1]; t = t.replace(new RegExp(accountNumber.split('').join('[\\s-]?')), ' '); }
  let bankName = null;
  for (const [alias, name] of ALIASES) {
    const re = new RegExp(`(^|[^a-z0-9])${esc(alias)}(?=$|[^a-z0-9])`, 'i');
    if (re.test(t)) { bankName = name; t = t.replace(new RegExp(`${esc(alias)}(\\s+(plc|bank|ltd|limited|nigeria|mfb|microfinance))*`, 'i'), ' '); break; }
  }
  const tidy = (x) => x.replace(/\b(account|acct|acc|a\/c|no|number|name|bank)\b\.?:?/gi, ' ').replace(/[,;|:·\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bankName && accountNumber) { // "Some Bank 0123456789 Name": take the words before the number as the bank
    const m = String(text).match(/^\s*([^\d,;|]+?)[\s,;|:-]*\d/);
    if (m && /bank|mfb|microfinance|psb/i.test(m[1])) { bankName = m[1].trim().slice(0, 80); t = t.replace(m[1].trim(), ' '); }
  }
  const rest = tidy(t);
  const accountName = rest && /[a-z]/i.test(rest) ? rest.slice(0, 100) : null;
  return { bankName, accountNumber, accountName, complete: !!(bankName && accountNumber && accountName) };
}
/** Validate separate payout fields. NGN accounts are NUBAN, exactly 10 digits. Throws { status: 400 }. */
function cleanBankFields({ bankName, accountNumber, accountName } = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400, expose: true });
  const bank = String(bankName || '').replace(/\s+/g, ' ').trim();
  if (bank.length < 2 || bank.length > 80) throw bad('Choose your bank');
  const num = String(accountNumber || '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(num)) throw bad('Nigerian account numbers are 10 digits');
  const name = String(accountName || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 100 || !/[a-z]/i.test(name)) throw bad('Add the account name as it appears at your bank');
  return { bankName: bank, accountNumber: num, accountName: name, bankDetails: `${bank} · ${num} · ${name}` };
}
module.exports = { BANKS, NAMES, parseBankText, cleanBankFields };
