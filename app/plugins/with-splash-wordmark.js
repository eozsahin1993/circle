/**
 * Puts the "mimoza" wordmark at the bottom of the native splash screen.
 * expo-splash-screen only takes one centred image, so this adds a second one:
 * Android 12+'s branding image, and an extra image view on the iOS storyboard.
 *
 * Must be listed before expo-splash-screen in app.json. Mods run last-added
 * first, and that plugin rebuilds the splash style and wipes the storyboard's
 * constraints and image resources, so this has to run after it does.
 */
const fs = require('fs');
const path = require('path');
const {
  withAndroidStyles,
  withDangerousMod,
  withMod,
} = require('expo/config-plugins');

const SOURCE = './assets/images/splash-wordmark.png';
const NAME = 'SplashWordmark';
const DRAWABLE = 'splashscreen_wordmark';
const VIEW_ID = 'MIMOZA-Wordmark';
// Android's branding image box; the PNG is drawn at 3x of it.
const WIDTH = 200;
const HEIGHT = 80;
// From the screen edge, not the safe area: expo-splash-screen re-hosts this view
// inside React Native's root view, whose safe area starts at zero and fills in
// after layout, so a safe-area constraint makes the wordmark jump mid-splash.
const BOTTOM_INSET = 58;

function withAndroidWordmark(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/drawable-xxhdpi');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(
        path.join(config.modRequest.projectRoot, SOURCE),
        path.join(dir, `${DRAWABLE}.png`),
      );
      return config;
    },
  ]);

  return withAndroidStyles(config, (config) => {
    const style = config.modResults.resources.style?.find(
      ({ $ }) => $.name === 'Theme.App.SplashScreen',
    );
    if (!style) {
      throw new Error('with-splash-wordmark: Theme.App.SplashScreen not found — is it listed before expo-splash-screen?');
    }
    const attr = 'android:windowSplashScreenBrandingImage';
    style.item = (style.item ?? []).filter(({ $ }) => $.name !== attr);
    style.item.push({ $: { name: attr }, _: `@drawable/${DRAWABLE}` });
    return config;
  });
}

function withIosWordmark(config) {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const { platformProjectRoot, projectName, projectRoot } = config.modRequest;
      const dir = path.join(platformProjectRoot, projectName, 'Images.xcassets', `${NAME}.imageset`);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(path.join(projectRoot, SOURCE), path.join(dir, 'image@3x.png'));
      await fs.promises.writeFile(
        path.join(dir, 'Contents.json'),
        JSON.stringify(
          {
            images: [
              { idiom: 'universal', scale: '1x' },
              { idiom: 'universal', scale: '2x' },
              { idiom: 'universal', filename: 'image@3x.png', scale: '3x' },
            ],
            info: { version: 1, author: 'expo' },
          },
          null,
          2,
        ),
      );
      return config;
    },
  ]);

  // expo-splash-screen's own mod name; its helper for this isn't exported.
  return withMod(config, {
    platform: 'ios',
    mod: 'splashScreenStoryboard',
    action: (config) => {
      const xml = config.modResults;
      const view = xml.document.scenes[0].scene[0].objects[0].viewController[0].view[0];

      const subviews = view.subviews[0];
      subviews.imageView = (subviews.imageView ?? []).filter(({ $ }) => $.id !== VIEW_ID);
      subviews.imageView.push({
        $: {
          id: VIEW_ID,
          userLabel: NAME,
          image: NAME,
          contentMode: 'scaleAspectFit',
          clipsSubviews: true,
          userInteractionEnabled: false,
          translatesAutoresizingMaskIntoConstraints: false,
        },
        rect: [{ $: { key: 'frame', x: 0, y: 0, width: WIDTH, height: HEIGHT } }],
        constraints: [
          {
            constraint: [
              { $: { firstAttribute: 'width', constant: WIDTH, id: `${VIEW_ID}-width` } },
              { $: { firstAttribute: 'height', constant: HEIGHT, id: `${VIEW_ID}-height` } },
            ],
          },
        ],
      });

      view.constraints[0].constraint = (view.constraints[0].constraint ?? []).filter(
        ({ $ }) => $.firstItem !== VIEW_ID && $.secondItem !== VIEW_ID,
      );
      view.constraints[0].constraint.push(
        {
          $: {
            firstItem: VIEW_ID,
            firstAttribute: 'centerX',
            secondItem: 'EXPO-ContainerView',
            secondAttribute: 'centerX',
            id: `${VIEW_ID}-centerX`,
          },
        },
        {
          $: {
            firstItem: 'EXPO-ContainerView',
            firstAttribute: 'bottom',
            secondItem: VIEW_ID,
            secondAttribute: 'bottom',
            constant: BOTTOM_INSET,
            id: `${VIEW_ID}-bottom`,
          },
        },
      );

      const resources = xml.document.resources[0];
      resources.image = (resources.image ?? []).filter(({ $ }) => $.name !== NAME);
      resources.image.push({ $: { name: NAME, width: WIDTH, height: HEIGHT } });
      return config;
    },
  });
}

module.exports = (config) => withIosWordmark(withAndroidWordmark(config));
