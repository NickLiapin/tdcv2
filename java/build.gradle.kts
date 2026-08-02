plugins {
    `java-library`
    antlr
}

group = "io.github.nickliapin"
version = "0.1.0-SNAPSHOT"

repositories {
    mavenCentral()
}

java {
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
