// CSS the page script takes in as text (esbuild's `text` loader), to put in a <style>.
declare module "*.css" {
  const css: string
  export default css
}
