/**
 * One-line structured logs in the app's "[tag] message" style, with key=value fields as JSON:
 *   [upload] stored {"id":"…","driver":"s3","bytes":51234,"ms":182}
 * Set UPLOAD_LOG=false to silence the info lines (warnings and errors always print).
 */
const quiet = () => String(process.env.UPLOAD_LOG || '').toLowerCase() === 'false';
function line(level, tag, step, fields) {
  if (level === 'info' && quiet()) return;
  const f = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields, (k, v) => (v === undefined ? undefined : v)) : '';
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${tag}] ${step}${f}`);
}
module.exports = {
  info: (tag, step, fields) => line('info', tag, step, fields),
  warn: (tag, step, fields) => line('warn', tag, step, fields),
  error: (tag, step, fields) => line('error', tag, step, fields),
};
