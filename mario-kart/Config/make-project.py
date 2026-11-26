# Writes MarioKart.xcodeproj/project.pbxproj (one iPhone app target, synchronized MarioKart/ folder).
# Usage: python3 Config/make-project.py MarioKart.xcodeproj/project.pbxproj TEAMID
import hashlib, sys
def I(n): return hashlib.md5(('mk-' + n).encode()).hexdigest()[:24].upper()
X = {k: I(k) for k in "project main products appProd gApp gConfig fInfo appT aSrc aFw aRes pDebug pRelease pList aDebug aRelease aList".split()}
team = sys.argv[2] if len(sys.argv) > 2 else ''
common = """				ALWAYS_SEARCH_USER_PATHS = NO;
				ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				ENABLE_USER_SCRIPT_SANDBOXING = YES;
				GCC_C_LANGUAGE_STANDARD = gnu17;
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				LOCALIZATION_PREFERS_STRING_CATALOGS = YES;
				SDKROOT = iphoneos;
"""
dbg = """				DEBUG_INFORMATION_FORMAT = dwarf;
				ENABLE_TESTABILITY = YES;
				GCC_OPTIMIZATION_LEVEL = 0;
				GCC_PREPROCESSOR_DEFINITIONS = (
					"DEBUG=1",
					"$(inherited)",
				);
				ONLY_ACTIVE_ARCH = YES;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
"""
rel = """				DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
				ENABLE_NS_ASSERTIONS = NO;
				SWIFT_COMPILATION_MODE = wholemodule;
				VALIDATE_PRODUCT = YES;
"""
app = f"""				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				DEVELOPMENT_TEAM = "{team}";
				ENABLE_PREVIEWS = YES;
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "Config/MarioKart-Info.plist";
				INFOPLIST_KEY_CFBundleDisplayName = "Kart Party";
				INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
				INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
				INFOPLIST_KEY_UILaunchScreen_Generation = YES;
				INFOPLIST_KEY_UIStatusBarHidden = YES;
				INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.jaredmackay.mariokart;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = 1;
"""
def cfg(k, name, body): return f"""		{X[k]} /* {name} */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
{body}			}};
			name = {name};
		}};
"""
def phase(k, isa, name): return f"""		{X[k]} /* {name} */ = {{
			isa = {isa};
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
"""
out = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 77;
	objects = {{

/* Begin PBXFileReference section */
		{X['appProd']} /* MarioKart.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = MarioKart.app; sourceTree = BUILT_PRODUCTS_DIR; }};
		{X['fInfo']} /* MarioKart-Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "MarioKart-Info.plist"; sourceTree = "<group>"; }};
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		{X['gApp']} /* MarioKart */ = {{
			isa = PBXFileSystemSynchronizedRootGroup;
			path = MarioKart;
			sourceTree = "<group>";
		}};
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
{phase('aFw','PBXFrameworksBuildPhase','Frameworks')}/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		{X['main']} = {{
			isa = PBXGroup;
			children = (
				{X['gApp']} /* MarioKart */,
				{X['gConfig']} /* Config */,
				{X['products']} /* Products */,
			);
			sourceTree = "<group>";
		}};
		{X['gConfig']} /* Config */ = {{
			isa = PBXGroup;
			children = (
				{X['fInfo']} /* MarioKart-Info.plist */,
			);
			path = Config;
			sourceTree = "<group>";
		}};
		{X['products']} /* Products */ = {{
			isa = PBXGroup;
			children = (
				{X['appProd']} /* MarioKart.app */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		{X['appT']} /* MarioKart */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {X['aList']} /* Build configuration list for PBXNativeTarget "MarioKart" */;
			buildPhases = (
				{X['aSrc']} /* Sources */,
				{X['aFw']} /* Frameworks */,
				{X['aRes']} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				{X['gApp']} /* MarioKart */,
			);
			name = MarioKart;
			productName = MarioKart;
			productReference = {X['appProd']} /* MarioKart.app */;
			productType = "com.apple.product-type.application";
		}};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		{X['project']} /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
				TargetAttributes = {{
					{X['appT']} = {{
						CreatedOnToolsVersion = 16.0;
					}};
				}};
			}};
			buildConfigurationList = {X['pList']} /* Build configuration list for PBXProject "MarioKart" */;
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = {X['main']};
			minimizedProjectReferenceProxies = 1;
			preferredProjectObjectVersion = 77;
			productRefGroup = {X['products']} /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				{X['appT']} /* MarioKart */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
{phase('aRes','PBXResourcesBuildPhase','Resources')}/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
{phase('aSrc','PBXSourcesBuildPhase','Sources')}/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
{cfg('pDebug','Debug',common+dbg)}{cfg('pRelease','Release',common+rel)}{cfg('aDebug','Debug',app)}{cfg('aRelease','Release',app)}/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		{X['pList']} /* Build configuration list for PBXProject "MarioKart" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{X['pDebug']} /* Debug */,
				{X['pRelease']} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{X['aList']} /* Build configuration list for PBXNativeTarget "MarioKart" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{X['aDebug']} /* Debug */,
				{X['aRelease']} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
/* End XCConfigurationList section */
	}};
	rootObject = {X['project']} /* Project object */;
}}
"""
open(sys.argv[1], 'w').write(out)
print('wrote', sys.argv[1])
