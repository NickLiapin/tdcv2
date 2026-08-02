plugins {
    `java-library`
    antlr
    `maven-publish`
    signing
}

group = "io.github.nickliapin"
version = "0.1.3"

repositories {
    mavenCentral()
}

java {
    // Maven Central refuses a publication without these two. They are also the difference
    // between a dependency an IDE can step into and one that is a wall of decompiled names.
    withSourcesJar()
    withJavadocJar()

    // The docs promise Java 17 and newer. Compiling with `release` rather than only setting a
    // toolchain means the bytecode is checked against the 17 API too, so a call that exists
    // only in a later JDK fails here instead of at a user's runtime.
    toolchain { languageVersion = JavaLanguageVersion.of(17) }
}

dependencies {
    // The ANTLR runtime is the one runtime dependency, and it mirrors the choice the
    // TypeScript implementation makes (antlr4ng). Everything else comes from the standard
    // library, which is the repository's stated dependency policy.
    antlr("org.antlr:antlr4:4.13.2")
    api("org.antlr:antlr4-runtime:4.13.2")

    // Test-only. Jackson reads the shared cross-language vectors, which are JSON.
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("com.fasterxml.jackson.core:jackson-databind:2.17.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// The grammar is not ours alone: the .g4 files under ../grammar are the single source the
// TypeScript implementation generates from as well. Pointing the ANTLR source set at that
// folder, instead of copying the files in, is what keeps the languages parsing one DSL.
//
// Written with line comments on purpose. Kotlin nests block comments, so a "/*" appearing
// inside one — as it does in a glob like grammar/(star).g4 — opens a nested comment and
// silently swallows the rest of the file.
val generatedPackage = "io.github.nickliapin.tdc.parser.generated"
val generatedPath = generatedPackage.replace(".", "/")

sourceSets {
    main {
        antlr {
            setSrcDirs(listOf(file("../grammar")))
        }
    }
}

tasks.generateGrammarSource {
    // ANTLR writes into a directory tree that has to match the package it stamps on the
    // generated classes, so both are derived from one value above.
    outputDirectory = layout.buildDirectory.dir("generated-src/antlr/main/" + generatedPath).get().asFile
    arguments = arguments + listOf("-package", generatedPackage, "-visitor", "-long-messages")
}

// A starter set of data packs ships inside the jar: `common`, the `en` locale, and the `usa`
// country. Enough that `person.male.firstName` resolves with no setup at all, and small enough
// that the library stays a library.
//
// Not all of them, deliberately. The pack collection is a growing body of DATA with its own
// release rhythm, and it lives in its own repository — one repository, shared by every
// implementation, so a locale added there appears in all of them at once. Vendoring a snapshot
// of it into each library would freeze it at build time and triple the places it has to be
// updated. Everything past the starter set is downloaded, into a pack store the config names.
//
// A jar cannot list its own directories, so an index is written alongside them. Without it there
// would be no way to answer "does the locale `sv` exist?" except by guessing filenames.
val packSource = file("../data/packs")
val packOutput = layout.buildDirectory.dir("generated-resources/packs")

/** The axes a library ships with: locale-agnostic, one language, one country. */
val starterPacks = listOf("common", "en", "countries/usa")

val bundlePacks by tasks.registering {
    inputs.dir(packSource)
    inputs.property("starter", starterPacks)
    outputs.dir(packOutput)
    doLast {
        val target = packOutput.get().dir("tdc/packs").asFile
        target.deleteRecursively()
        val index = StringBuilder()
        packSource.walkTopDown().filter { it.isFile && it.extension == "txt" }.forEach { file ->
            val relative = file.relativeTo(packSource).invariantSeparatorsPath
            if (starterPacks.none { relative == it || relative.startsWith("$it/") }) return@forEach
            file.copyTo(target.resolve(relative).also { it.parentFile.mkdirs() }, overwrite = true)
            index.append(relative).append('\n')
        }
        target.resolve("index.txt").writeText(index.toString())
    }
}

sourceSets.main {
    resources.srcDir(packOutput)
}

tasks.processResources {
    dependsOn(bundlePacks)
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 17
    // -Werror is deliberately absent: this compiles ANTLR's generated sources too, and their
    // warnings are not ours to fix.
    options.compilerArgs.add("-Xlint:all")
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
    // Fixtures and data packs live at the repository root, shared with the other ports.
    systemProperty("tdc.fixtures", file("../fixtures").absolutePath)
    systemProperty("tdc.packs", file("../data/packs").absolutePath)

    // Gradle decides whether to re-run the tests from the inputs it has been told about,
    // and both directories above are read at RUNTIME through a system property — invisible
    // to that decision. Without these two lines, changing a shared fixture leaves the task
    // UP-TO-DATE: Gradle reports success on a suite it never ran, which is the one failure
    // this suite exists to catch. The other four implementations re-run unconditionally.
    inputs.dir(file("../fixtures"))
    inputs.dir(file("../data/packs"))
}


/**
 * The runtime classpath, written where a benchmark script can read it.
 *
 * A benchmark that ran through Gradle would measure Gradle's startup as well as the library's,
 * and the startup cost is exactly one of the things being compared.
 */
val benchClasspath by tasks.registering {
    val out = layout.buildDirectory.file("bench-classpath.txt")
    outputs.file(out)
    val cp = configurations.named("runtimeClasspath")
    val jarFile = tasks.named<Jar>("jar").flatMap { it.archiveFile }
    doLast {
        val entries = (listOf(jarFile.get().asFile) + cp.get().files).joinToString(":")
        out.get().asFile.writeText(entries)
    }
}

/**
 * `tdcv2.jar` — the CLI, dependencies and starter packs in one file.
 *
 * A Java user should not need another language's toolchain to run a `.tdc` file, and Maven has no
 * equivalent of npm's `bin`: adding a library to a project does not put a command on the PATH. A
 * single self-contained jar is what closes that gap — `java -jar tdcv2.jar users.tdc` works with
 * nothing installed but a JDK.
 *
 * The one runtime dependency is ANTLR's runtime, so this unpacks it rather than pulling in a
 * shading plugin. Signature files from any signed dependency are dropped: they describe the jar
 * they came in, and keeping them makes the merged jar fail verification.
 */
val cliJar by tasks.registering(Jar::class) {
    group = "distribution"
    description = "Self-contained executable jar: java -jar tdcv2.jar <config.tdc>"
    archiveBaseName = "tdcv2"
    archiveClassifier = "cli"

    manifest {
        attributes(
            "Main-Class" to "io.github.nickliapin.tdc.cli.Main",
            "Implementation-Title" to "TDC — The Data Constructor",
            "Implementation-Version" to project.version,
        )
    }

    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
        configurations.runtimeClasspath.get()
            .filter { it.name.endsWith("jar") }
            .map { zipTree(it) }
    }) {
        exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/MANIFEST.MF")
    }
    // Two dependencies can carry the same licence file; the jar only needs one of each.
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

tasks.named("assemble") {
    dependsOn(cliJar)
}

// The ANTLR plugin generates into the main source set, so anything that reads that source
// set has to wait for it. Gradle cannot infer the edge on its own and says so rather than
// racing — which is right, and is why this is spelled out instead of disabled.
tasks.named("sourcesJar") {
    dependsOn(tasks.named("generateGrammarSource"), bundlePacks)
}

// ── Publishing ──────────────────────────────────────────────────────────────────────────
//
// Maven Central asks for more than a jar: a POM that says who wrote this, under what licence
// and where the source lives, plus sources and javadoc archives, plus a cryptographic
// signature on every file. None of it is optional — the Portal validates and rejects.
//
// The signing key never lives in this repository. In CI it arrives through two secrets, and
// on a laptop through the ordinary gpg agent; `signing.isRequired` is false when neither is
// present so that `./gradlew build` on a fresh checkout does not demand a key nobody has.

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["java"])

            // The command line, under the SAME coordinates as the library.
            //
            // Maven has no equivalent of npm's `bin`: adding a dependency to a project puts
            // nothing on anyone's PATH. So the command line is a file people download —
            // `tdcv2-<version>-cli.jar`, self-contained, `java -jar` and it runs. NuGet needs
            // a whole second package for this; Maven does not, because one set of coordinates
            // can carry several files told apart by a classifier. One address, one signature
            // pass, nothing extra to publish.
            artifact(cliJar)

            pom {
                // No `packaging` here: Gradle drops the element when it equals the default
                // it is already producing, so setting it changes nothing. Verified by
                // reading the POM out of the built bundle. Central does not ask for it.
                name = "TDC — The Data Constructor"
                description =
                    "Deterministic test-data generator: coherent records, exact proportions, " +
                        "and any text format you describe. Same seed, same bytes — in Java, " +
                        "TypeScript, Python, C# and Rust alike."
                url = "https://nickliapin.github.io/tdcv2/"

                licenses {
                    license {
                        name = "MIT License"
                        url = "https://opensource.org/licenses/MIT"
                    }
                }
                developers {
                    developer {
                        id = "nickliapin"
                        name = "Nick Liapin"
                        url = "https://github.com/NickLiapin"
                    }
                }
                scm {
                    connection = "scm:git:https://github.com/NickLiapin/tdcv2.git"
                    developerConnection = "scm:git:ssh://git@github.com/NickLiapin/tdcv2.git"
                    url = "https://github.com/NickLiapin/tdcv2"
                }
            }
        }
    }

    repositories {
        // A folder, not a server. The Central Portal takes a zip of a repository layout
        // rather than a stream of uploads, so the publish step builds one here and the
        // workflow posts it. That also means `./gradlew publish` is safe to run by hand:
        // it writes files and reaches nothing.
        maven {
            name = "central"
            url = uri(layout.buildDirectory.dir("central"))
        }
    }
}

signing {
    // Two ways in, and neither puts a key in this repository.
    //
    // In CI: the armoured private key and its passphrase, both from repository secrets.
    // On a laptop: `-Psigning.gnupg.keyName=<key id>`, which hands the work to the installed
    // gpg and lets its agent ask for the passphrase — nothing secret passes through Gradle.
    //
    // With neither, signing is skipped rather than failing, so a contributor who only wants
    // to run the tests is not asked for a key nobody but the publisher has.
    val key = providers.environmentVariable("GPG_SIGNING_KEY").orNull
    val passphrase = providers.environmentVariable("GPG_SIGNING_PASSPHRASE").orNull
    val localKeyName = providers.gradleProperty("signing.gnupg.keyName").orNull
    isRequired = key != null || localKeyName != null

    if (key != null) {
        useInMemoryPgpKeys(key, passphrase)
    } else if (localKeyName != null) {
        useGpgCmd()
    }
    sign(publishing.publications["mavenJava"])
}
