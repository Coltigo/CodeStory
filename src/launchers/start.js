ObjC.import('Foundation');
function run() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const bundle = ObjC.unwrap($.NSBundle.mainBundle.bundlePath);
  const root = ObjC.unwrap($(bundle).stringByDeletingLastPathComponent);
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    app.doShellScript('/bin/zsh ' + quote(root + '/Launch CodeStory.command'));
  } catch (error) {
    app.displayAlert('CodeStory could not start', {message: String(error.message || error)});
  }
}
