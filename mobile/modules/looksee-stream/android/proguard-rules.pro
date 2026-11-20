# Release-build shrinking (R8) rules for the looksee-stream module. Android
# starts the service and boot receiver by class name from the manifest, and
# Expo finds the module class by name, so none of them may be renamed or removed.
-keep class expo.modules.lookseestream.** { *; }
