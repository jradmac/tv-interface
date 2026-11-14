import hashlib, sys
def I(n): return hashlib.md5(n.encode()).hexdigest()[:24].upper()
ids = {k: I(k) for k in """project main products appProd wgtProd gApp gShared gWgt gConfig
fInfo fEnt fWInfo fWEnt appT wgtT aSrc aFw aRes aEmbed wSrc wFw wRes embedBF dep proxy
pDebug pRelease pList aDebug aRelease aList wDebug wRelease wList""".split()}
X = ids
common_proj = """				ALWAYS_SEARCH_USER_PATHS = NO;
				ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;
				CLANG_ANALYZER_NONNULL = YES;
				CLANG_CXX_LANGUAGE_STANDARD = "gnu++20";
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				CLANG_ENABLE_OBJC_WEAK = YES;
				CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING = YES;
				CLANG_WARN_BOOL_CONVERSION = YES;
				CLANG_WARN_COMMA = YES;
				CLANG_WARN_CONSTANT_CONVERSION = YES;
				CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS = YES;
				CLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR;
				CLANG_WARN_DOCUMENTATION_COMMENTS = YES;
				CLANG_WARN_EMPTY_BODY = YES;
				CLANG_WARN_ENUM_CONVERSION = YES;
				CLANG_WARN_INFINITE_RECURSION = YES;
				CLANG_WARN_INT_CONVERSION = YES;
				CLANG_WARN_NON_LITERAL_NULL_CONVERSION = YES;
				CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF = YES;
				CLANG_WARN_OBJC_LITERAL_CONVERSION = YES;
				CLANG_WARN_OBJC_ROOT_CLASS = YES_ERROR;
				CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;
				CLANG_WARN_RANGE_LOOP_ANALYSIS = YES;
				CLANG_WARN_STRICT_PROTOTYPES = YES;
				CLANG_WARN_SUSPICIOUS_MOVE = YES;
				CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;
				CLANG_WARN_UNREACHABLE_CODE = YES;
				CLANG_WARN__DUPLICATE_METHOD_MATCH = YES;
				COPY_PHASE_STRIP = NO;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				ENABLE_USER_SCRIPT_SANDBOXING = YES;
				GCC_C_LANGUAGE_STANDARD = gnu17;
				GCC_NO_COMMON_BLOCKS = YES;
				GCC_WARN_64_TO_32_BIT_CONVERSION = YES;
				GCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;
				GCC_WARN_UNDECLARED_SELECTOR = YES;
				GCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;
				GCC_WARN_UNUSED_FUNCTION = YES;
				GCC_WARN_UNUSED_VARIABLE = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 18.0;
				LOCALIZATION_PREFERS_STRING_CATALOGS = YES;
				MTL_FAST_MATH = YES;
				SDKROOT = iphoneos;
"""
debug_proj = """				DEBUG_INFORMATION_FORMAT = dwarf;
				ENABLE_TESTABILITY = YES;
				GCC_DYNAMIC_NO_PIC = NO;
				GCC_OPTIMIZATION_LEVEL = 0;
				GCC_PREPROCESSOR_DEFINITIONS = (
					"DEBUG=1",
					"$(inherited)",
				);
				MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
				ONLY_ACTIVE_ARCH = YES;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
"""
release_proj = """				DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
				ENABLE_NS_ASSERTIONS = NO;
				MTL_ENABLE_DEBUG_INFO = NO;
				SWIFT_COMPILATION_MODE = wholemodule;
				VALIDATE_PRODUCT = YES;
"""
team = sys.argv[2] if len(sys.argv) > 2 else ''
app = f"""				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
				CODE_SIGN_ENTITLEMENTS = Config/TVRemote.entitlements;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				DEVELOPMENT_TEAM = "{team}";
				ENABLE_PREVIEWS = YES;
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "Config/TVRemote-Info.plist";
				INFOPLIST_KEY_CFBundleDisplayName = "TV Remote";
				INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
				INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
				INFOPLIST_KEY_UILaunchScreen_Generation = YES;
				INFOPLIST_KEY_UIStatusBarStyle = UIStatusBarStyleDarkContent;
				INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = UIInterfaceOrientationPortrait;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.jaredmackay.tvremote;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = 1;
"""
wgt = f"""				CODE_SIGN_ENTITLEMENTS = Config/TVRemoteWidgets.entitlements;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				DEVELOPMENT_TEAM = "{team}";
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "Config/TVRemoteWidgets-Info.plist";
				INFOPLIST_KEY_CFBundleDisplayName = "TV Remote";
				INFOPLIST_KEY_NSHumanReadableCopyright = "";
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
					"@executable_path/../../Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.jaredmackay.tvremote.widgets;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SKIP_INSTALL = YES;
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = 1;
"""
def cfg(key, name, body): return f"""		{X[key]} /* {name} */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
{body}			}};
			name = {name};
		}};
"""
def phase(key, isa, name):
    return f"""		{X[key]} /* {name} */ = {{
			isa = {isa};
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
"""
def sync(key, path): return f"""		{X[key]} /* {path} */ = {{
			isa = PBXFileSystemSynchronizedRootGroup;
			path = {path};
			sourceTree = "<group>";
		}};
"""
def fref(key, path, t): return f"""		{X[key]} /* {path} */ = {{isa = PBXFileReference; lastKnownFileType = {t}; path = "{path}"; sourceTree = "<group>"; }};
"""
out = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 77;
	objects = {{

/* Begin PBXBuildFile section */
		{X['embedBF']} /* TVRemoteWidgets.appex in Embed Foundation Extensions */ = {{isa = PBXBuildFile; fileRef = {X['wgtProd']} /* TVRemoteWidgets.appex */; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy, ); }}; }};
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
		{X['proxy']} /* PBXContainerItemProxy */ = {{
			isa = PBXContainerItemProxy;
			containerPortal = {X['project']} /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = {X['wgtT']};
			remoteInfo = TVRemoteWidgets;
		}};
/* End PBXContainerItemProxy section */

/* Begin PBXCopyFilesBuildPhase section */
		{X['aEmbed']} /* Embed Foundation Extensions */ = {{
			isa = PBXCopyFilesBuildPhase;
			buildActionMask = 2147483647;
			dstPath = "";
			dstSubfolderSpec = 13;
			files = (
				{X['embedBF']} /* TVRemoteWidgets.appex in Embed Foundation Extensions */,
			);
			name = "Embed Foundation Extensions";
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXCopyFilesBuildPhase section */

/* Begin PBXFileReference section */
		{X['appProd']} /* TVRemote.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = TVRemote.app; sourceTree = BUILT_PRODUCTS_DIR; }};
		{X['wgtProd']} /* TVRemoteWidgets.appex */ = {{isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = TVRemoteWidgets.appex; sourceTree = BUILT_PRODUCTS_DIR; }};
{fref('fInfo','TVRemote-Info.plist','text.plist.xml')}{fref('fEnt','TVRemote.entitlements','text.plist.entitlements')}{fref('fWInfo','TVRemoteWidgets-Info.plist','text.plist.xml')}{fref('fWEnt','TVRemoteWidgets.entitlements','text.plist.entitlements')}/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
{sync('gApp','TVRemote')}{sync('gShared','Shared')}{sync('gWgt','TVRemoteWidgets')}/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
{phase('aFw','PBXFrameworksBuildPhase','Frameworks')}{phase('wFw','PBXFrameworksBuildPhase','Frameworks')}/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		{X['main']} = {{
			isa = PBXGroup;
			children = (
				{X['gApp']} /* TVRemote */,
				{X['gShared']} /* Shared */,
				{X['gWgt']} /* TVRemoteWidgets */,
				{X['gConfig']} /* Config */,
				{X['products']} /* Products */,
			);
			sourceTree = "<group>";
		}};
		{X['gConfig']} /* Config */ = {{
			isa = PBXGroup;
			children = (
				{X['fInfo']} /* TVRemote-Info.plist */,
				{X['fEnt']} /* TVRemote.entitlements */,
				{X['fWInfo']} /* TVRemoteWidgets-Info.plist */,
				{X['fWEnt']} /* TVRemoteWidgets.entitlements */,
			);
			path = Config;
			sourceTree = "<group>";
		}};
		{X['products']} /* Products */ = {{
			isa = PBXGroup;
			children = (
				{X['appProd']} /* TVRemote.app */,
				{X['wgtProd']} /* TVRemoteWidgets.appex */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		{X['appT']} /* TVRemote */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {X['aList']} /* Build configuration list for PBXNativeTarget "TVRemote" */;
			buildPhases = (
				{X['aSrc']} /* Sources */,
				{X['aFw']} /* Frameworks */,
				{X['aRes']} /* Resources */,
				{X['aEmbed']} /* Embed Foundation Extensions */,
			);
			buildRules = (
			);
			dependencies = (
				{X['dep']} /* PBXTargetDependency */,
			);
			fileSystemSynchronizedGroups = (
				{X['gApp']} /* TVRemote */,
				{X['gShared']} /* Shared */,
			);
			name = TVRemote;
			packageProductDependencies = (
			);
			productName = TVRemote;
			productReference = {X['appProd']} /* TVRemote.app */;
			productType = "com.apple.product-type.application";
		}};
		{X['wgtT']} /* TVRemoteWidgets */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {X['wList']} /* Build configuration list for PBXNativeTarget "TVRemoteWidgets" */;
			buildPhases = (
				{X['wSrc']} /* Sources */,
				{X['wFw']} /* Frameworks */,
				{X['wRes']} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				{X['gWgt']} /* TVRemoteWidgets */,
				{X['gShared']} /* Shared */,
			);
			name = TVRemoteWidgets;
			packageProductDependencies = (
			);
			productName = TVRemoteWidgets;
			productReference = {X['wgtProd']} /* TVRemoteWidgets.appex */;
			productType = "com.apple.product-type.app-extension";
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
					{X['wgtT']} = {{
						CreatedOnToolsVersion = 16.0;
					}};
				}};
			}};
			buildConfigurationList = {X['pList']} /* Build configuration list for PBXProject "TVRemote" */;
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
				{X['appT']} /* TVRemote */,
				{X['wgtT']} /* TVRemoteWidgets */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
{phase('aRes','PBXResourcesBuildPhase','Resources')}{phase('wRes','PBXResourcesBuildPhase','Resources')}/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
{phase('aSrc','PBXSourcesBuildPhase','Sources')}{phase('wSrc','PBXSourcesBuildPhase','Sources')}/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		{X['dep']} /* PBXTargetDependency */ = {{
			isa = PBXTargetDependency;
			target = {X['wgtT']} /* TVRemoteWidgets */;
			targetProxy = {X['proxy']} /* PBXContainerItemProxy */;
		}};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
{cfg('pDebug','Debug',common_proj+debug_proj)}{cfg('pRelease','Release',common_proj+release_proj)}{cfg('aDebug','Debug',app)}{cfg('aRelease','Release',app)}{cfg('wDebug','Debug',wgt)}{cfg('wRelease','Release',wgt)}/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		{X['pList']} /* Build configuration list for PBXProject "TVRemote" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{X['pDebug']} /* Debug */,
				{X['pRelease']} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{X['aList']} /* Build configuration list for PBXNativeTarget "TVRemote" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{X['aDebug']} /* Debug */,
				{X['aRelease']} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{X['wList']} /* Build configuration list for PBXNativeTarget "TVRemoteWidgets" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{X['wDebug']} /* Debug */,
				{X['wRelease']} /* Release */,
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
scheme = f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{X['appT']}" BuildableName = "TVRemote.app" BlueprintName = "TVRemote" ReferencedContainer = "container:TVRemote.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{X['appT']}" BuildableName = "TVRemote.app" BlueprintName = "TVRemote" ReferencedContainer = "container:TVRemote.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""
open(sys.argv[1].replace('project.pbxproj', 'xcshareddata/xcschemes/TVRemote.xcscheme'), 'w').write(scheme)
