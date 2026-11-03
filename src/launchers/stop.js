ObjC.import('Foundation');
function run() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const bundle = ObjC.unwrap($.NSBundle.mainBundle.bundlePath);
  const root = ObjC.unwrap($(bundle).stringByDeletingLastPathComponent);
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    const result = app.doShellScript('/bin/zsh ' + quote(root + '/Stop CodeStory.command'));
    app.displayAlert('CodeStory', {message: result});
  } catch (error) {
    app.displayAlert('CodeStory could not stop', {message: String(error.message || error)});
  }
}
