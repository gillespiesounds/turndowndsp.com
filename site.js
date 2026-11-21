/* Turndown DSP: the measuring instruments, in plain JavaScript.
   Ported from Jake's Framer code components (FloorLines, MeasureReadout, PhaseScope)
   and the Measure Cursor component. No libraries.

   The whole page is one EQ graph. Across the window, x runs 20 Hz to 20 kHz on a log
   scale; down the window, y runs +12 dB to -12 dB. On wide screens the graph starts at
   the rail's edge, not the window's. Every reading and drawing uses the same two numbers. */
(function () {
    "use strict"

    var F_LO = 20
    var F_HI = 20000
    var G_RANGE = 12
    var FS = 48000
    var RAIL_WIDTH = 248
    var RAIL_FROM = 1200
    var IDLE_AFTER_MS = 4000
    var POINTS = 220
    var SCOPE_POINTS = 360
    var SVG_NS = "http://www.w3.org/2000/svg"

    // First paint: 1.00 kHz, -3.0 dB.
    var REST = { xn: Math.log(1000 / F_LO) / Math.log(F_HI / F_LO), yn: (G_RANGE + 3) / (2 * G_RANGE) }

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    var touchOnly = window.matchMedia("(hover: none)").matches

    function clamp01(v) {
        return Math.min(1, Math.max(0, v))
    }
    function railInset() {
        return window.innerWidth >= RAIL_FROM ? RAIL_WIDTH : 0
    }
    function graphX(clientX) {
        var inset = railInset()
        return (clientX - inset) / Math.max(1, window.innerWidth - inset)
    }
    function freqAt(xn) {
        return F_LO * Math.pow(F_HI / F_LO, xn)
    }
    function gainAt(yn) {
        return G_RANGE - 2 * G_RANGE * yn
    }
    function xnAt(f) {
        return Math.log(f / F_LO) / Math.log(F_HI / F_LO)
    }

    function formatFreq(raw) {
        // Round to what is shown first, so 999.99 Hz reads 1.00 kHz, not 1000 Hz.
        var f = Number(raw.toPrecision(3))
        if (f >= 10000) return { value: (f / 1000).toFixed(1), unit: "kHz" }
        if (f >= 1000) return { value: (f / 1000).toFixed(2), unit: "kHz" }
        if (f >= 100) return { value: f.toFixed(0), unit: "Hz" }
        return { value: f.toFixed(1), unit: "Hz" }
    }
    function formatGain(g) {
        var r = Math.round(g * 10) / 10
        if (r === 0) return { value: "0.0", unit: "dB" }
        return { value: (r > 0 ? "+" : "−") + Math.abs(r).toFixed(1), unit: "dB" }
    }

    function svgEl(name, attrs) {
        var el = document.createElementNS(SVG_NS, name)
        for (var k in attrs) el.setAttribute(k, attrs[k])
        return el
    }

    /* ---------- Readouts (rail, top strip, cursor) and phase scope ---------- */

    var freqEls = document.querySelectorAll("[data-freq]")
    var freqUnitEls = document.querySelectorAll("[data-freq-unit]")
    var gainEls = document.querySelectorAll("[data-gain]")
    var gainUnitEls = document.querySelectorAll("[data-gain-unit]")
    var readout = document.getElementById("readout")
    var tick = document.getElementById("readout-tick")
    var scopeTrace = document.getElementById("scope-trace")

    var reading = { xn: REST.xn, yn: REST.yn }
    var readingFrame = 0

    function setText(list, text) {
        for (var i = 0; i < list.length; i++) if (list[i].textContent !== text) list[i].textContent = text
    }

    function drawScope(xn) {
        if (!scopeTrace) return
        var r = 42
        var c = 50
        var phase = xn * 1.5 * 2 * Math.PI
        var d = ""
        for (var n = 0; n <= SCOPE_POINTS; n++) {
            var t = (2 * Math.PI * n) / SCOPE_POINTS
            var x = c + r * Math.sin(3 * t + phase)
            var y = c - r * Math.sin(2 * t)
            d += (n === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2)
        }
        scopeTrace.setAttribute("d", d)
    }

    function commitReading() {
        readingFrame = 0
        var freq = formatFreq(freqAt(reading.xn))
        var gain = formatGain(gainAt(reading.yn))
        setText(freqEls, freq.value)
        setText(freqUnitEls, freq.unit)
        setText(gainEls, gain.value)
        setText(gainUnitEls, gain.unit)
        if (tick) {
            var pct = (reading.xn * 100).toFixed(2) + "%"
            tick.setAttribute("x1", pct)
            tick.setAttribute("x2", pct)
        }
        if (readout) {
            readout.setAttribute(
                "aria-label",
                "Cursor reading: " + freq.value + " " + freq.unit + ", " + gain.value + " " + gain.unit
            )
        }
        drawScope(reading.xn)
    }

    function setReading(xn, yn) {
        reading = { xn: clamp01(xn), yn: clamp01(yn) }
        if (!readingFrame) readingFrame = window.requestAnimationFrame(commitReading)
    }

    /* ---------- Floor lines ---------- */

    // |H| in dB of one biquad (RBJ cookbook coefficients) at frequency f.
    function biquadDb(b0, b1, b2, a0, a1, a2, f) {
        var w = (2 * Math.PI * f) / FS
        var c1 = Math.cos(w)
        var c2 = Math.cos(2 * w)
        var s1 = Math.sin(w)
        var s2 = Math.sin(2 * w)
        var nr = b0 + b1 * c1 + b2 * c2
        var ni = -(b1 * s1 + b2 * s2)
        var dr = a0 + a1 * c1 + a2 * c2
        var di = -(a1 * s1 + a2 * s2)
        return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
    }
    function bellDb(f, f0, gainDb, q) {
        var A = Math.pow(10, gainDb / 40)
        var w0 = (2 * Math.PI * f0) / FS
        var alpha = Math.sin(w0) / (2 * q)
        var c = Math.cos(w0)
        return biquadDb(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A, f)
    }
    function highShelfDb(f, f0, gainDb) {
        var A = Math.pow(10, gainDb / 40)
        var w0 = (2 * Math.PI * f0) / FS
        var c = Math.cos(w0)
        var k = 2 * Math.sqrt(A) * (Math.sin(w0) / 2) * Math.SQRT2
        return biquadDb(
            A * (A + 1 + (A - 1) * c + k),
            -2 * A * (A - 1 + (A + 1) * c),
            A * (A + 1 + (A - 1) * c - k),
            A + 1 - (A - 1) * c + k,
            2 * (A - 1 - (A + 1) * c),
            A + 1 - (A - 1) * c - k,
            f
        )
    }
    function highPassDb(f, f0) {
        var w0 = (2 * Math.PI * f0) / FS
        var c = Math.cos(w0)
        var alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
        return biquadDb((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha, f)
    }

    var floor = (function () {
        var root = document.getElementById("floor")
        if (!root) return null

        var BUS = "bus"
        var TRACKS = ["ch 1", "ch 2", "ch 3"]
        var Q = 1.2
        var HPF = 30
        var SHELF = 2
        var LINE = "#151514"
        var TRACK = "#5C5A55"
        var RULE = "#CFC8BA"
        var ACCENT = "#8C4700"

        var rest = { lf: Math.log(freqAt(REST.xn)), g: gainAt(REST.yn) }
        var target = { lf: rest.lf, g: rest.g }
        var live = []
        for (var i = 0; i <= TRACKS.length; i++) live.push({ lf: rest.lf, g: rest.g })
        var box = { w: 1000, h: 320, left: 0, vw: 1000 }
        var lastInput = 0
        var mouseSeen = false
        var raf = 0
        var inView = false

        var svg = svgEl("svg", {
            role: "img",
            "aria-label": "An equaliser curve on the bus, with three tracks following it",
        })
        svg.style.display = "block"
        svg.style.overflow = "visible"
        var curves = []
        var names = []
        for (i = 0; i < live.length; i++) {
            var p = svgEl("path", {
                fill: "none",
                stroke: i === 0 ? LINE : TRACK,
                "stroke-opacity": i === 0 ? 1 : Math.max(0.3, 0.8 - i * 0.15),
                "stroke-width": i === 0 ? 1.25 : 1,
                "stroke-linecap": "square",
                "stroke-linejoin": "miter",
            })
            curves.push(p)
            svg.appendChild(p)
        }
        for (i = 0; i < live.length; i++) {
            var t = svgEl("text", { "text-anchor": "end", fill: i === 0 ? LINE : TRACK })
            t.textContent = i === 0 ? BUS : TRACKS[i - 1]
            names.push(t)
            svg.appendChild(t)
        }
        var marker = svgEl("g", {})
        var drop = svgEl("line", { stroke: RULE, "stroke-width": 1 })
        var dot = svgEl("rect", { width: 5, height: 5, fill: ACCENT })
        marker.appendChild(drop)
        marker.appendChild(dot)
        svg.appendChild(marker)
        var axis = svgEl("g", {})
        svg.appendChild(axis)
        root.appendChild(svg)

        // Layout of the drawing, in this band's own pixels.
        var gutter = 56
        var padTop = 28
        var axisH = 40
        var L = {}
        function layout() {
            var w = box.w
            var h = box.h
            L.plotW = Math.max(0, w - gutter)
            L.plotBottom = h - axisH
            L.P = Math.max(40, L.plotBottom - padTop)
            L.dbPx = (L.P * 0.2) / G_RANGE
            L.axisY = L.plotBottom + 10.5
        }
        function zeroAt(i) {
            return padTop + L.P * 0.28 + (i === 0 ? 0 : (i * (L.P * 0.58)) / Math.max(1, TRACKS.length))
        }
        function xAt(f) {
            return xnAt(f) * box.vw - box.left
        }
        function fAtX(x) {
            return freqAt((x + box.left) / Math.max(1, box.vw))
        }
        function fixedDb(f) {
            return highPassDb(f, HPF) + highShelfDb(f, 10000, SHELF)
        }
        function limit(db) {
            return Math.max(-G_RANGE - 2, Math.min(G_RANGE + 2, db))
        }

        // Fixed part of every curve (high-pass + air shelf), per x position. Recomputed on resize only.
        var fAtPoint = []
        var fixedAtPoint = []

        function drawAxis() {
            while (axis.firstChild) axis.removeChild(axis.firstChild)
            axis.appendChild(svgEl("line", { x1: 0, y1: L.axisY, x2: L.plotW, y2: L.axisY, stroke: RULE, "stroke-width": 1 }))
            var decades = []
            for (var d = 10; d <= 10000; d *= 10) for (var m = 1; m <= 9; m++) decades.push(d * m)
            decades.push(20000)
            var named = [20, 100, 1000, 10000, 20000]
            for (var n = 0; n < decades.length; n++) {
                var f = decades[n]
                var x = xAt(f)
                if (x < 0 || x > L.plotW) continue
                var major = named.indexOf(f) !== -1
                axis.appendChild(
                    svgEl("line", {
                        x1: x,
                        y1: L.axisY,
                        x2: x,
                        y2: L.axisY + (major ? 7 : 4),
                        stroke: major ? TRACK : RULE,
                        "stroke-width": 1,
                    })
                )
                if (major) {
                    var label = svgEl("text", {
                        x: x,
                        y: L.axisY + 21,
                        "text-anchor": x < 12 ? "start" : x > L.plotW - 12 ? "end" : "middle",
                        fill: TRACK,
                    })
                    label.textContent = f >= 1000 ? f / 1000 + "k" : String(f)
                    axis.appendChild(label)
                }
            }
            var hz = svgEl("text", { x: box.w, y: L.axisY + 21, "text-anchor": "end", fill: TRACK })
            hz.textContent = "Hz"
            axis.appendChild(hz)
        }

        function draw() {
            for (var i = 0; i < live.length; i++) {
                var b = live[i]
                var f0 = Math.exp(b.lf)
                var y0 = zeroAt(i)
                var d = ""
                for (var n = 0; n <= POINTS; n++) {
                    var x = (L.plotW * n) / POINTS
                    var db = limit(fixedAtPoint[n] + bellDb(fAtPoint[n], f0, b.g, Q))
                    d += (n === 0 ? "M" : "L") + x.toFixed(1) + " " + (y0 - db * L.dbPx).toFixed(1)
                }
                curves[i].setAttribute("d", d)
            }
            var master = live[0]
            var mf = Math.exp(master.lf)
            var dotX = xAt(mf)
            var dotY = zeroAt(0) - limit(fixedDb(mf) + bellDb(mf, mf, master.g, Q)) * L.dbPx
            if (dotX >= 0 && dotX <= L.plotW) {
                marker.style.display = ""
                drop.setAttribute("x1", dotX)
                drop.setAttribute("y1", dotY)
                drop.setAttribute("x2", dotX)
                drop.setAttribute("y2", L.axisY)
                dot.setAttribute("x", dotX - 2.5)
                dot.setAttribute("y", dotY - 2.5)
            } else {
                marker.style.display = "none"
            }
        }

        // Size and position of this band, so its axis lines up with the window's.
        function measure() {
            var r = root.getBoundingClientRect()
            var inset = railInset()
            box = { w: r.width, h: r.height, left: r.left - inset, vw: window.innerWidth - inset }
            svg.setAttribute("width", box.w)
            svg.setAttribute("height", box.h)
            svg.setAttribute("viewBox", "0 0 " + box.w + " " + box.h)
            layout()
            fAtPoint = []
            fixedAtPoint = []
            for (var n = 0; n <= POINTS; n++) {
                var f = fAtX((L.plotW * n) / POINTS)
                fAtPoint.push(f)
                fixedAtPoint.push(fixedDb(f))
            }
            for (var i = 0; i < names.length; i++) {
                names[i].setAttribute("x", box.w)
                names[i].setAttribute("y", zeroAt(i) + 4)
            }
            drawAxis()
            draw()
        }

        function frame(now) {
            raf = 0
            var moving = false
            // Idle drift: before the first mouse move, or on touch screens after a pause.
            var idleNow = !reduced && (touchOnly ? now - lastInput > IDLE_AFTER_MS : !mouseSeen)
            if (idleNow) {
                var t = now / 1000
                var xn = 0.55 + 0.3 * Math.sin((2 * Math.PI * t) / 16)
                var yn = 0.5 + 0.18 * Math.sin((2 * Math.PI * t) / 11)
                target = { lf: Math.log(freqAt(xn)), g: gainAt(yn) }
                setReading(xn, yn)
                moving = true
            }
            var k0 = reduced ? 1 : 0.35
            live[0] = {
                lf: live[0].lf + (target.lf - live[0].lf) * k0,
                g: live[0].g + (target.g - live[0].g) * k0,
            }
            for (var i = 1; i < live.length; i++) {
                var k = reduced ? 1 : 0.11 / Math.sqrt(i)
                live[i] = {
                    lf: live[i].lf + (live[i - 1].lf - live[i].lf) * k,
                    g: live[i].g + (live[i - 1].g - live[i].g) * k,
                }
            }
            var last = live[live.length - 1]
            if (
                Math.abs(target.lf - live[0].lf) > 1e-4 ||
                Math.abs(target.g - live[0].g) > 1e-3 ||
                Math.abs(live[0].lf - last.lf) > 1e-4 ||
                Math.abs(live[0].g - last.g) > 1e-3
            ) {
                moving = true
            }
            draw()
            if (moving && inView) raf = window.requestAnimationFrame(frame)
        }
        function start() {
            if (!raf && inView) raf = window.requestAnimationFrame(frame)
        }
        function aim(xn, yn) {
            target = { lf: Math.log(freqAt(clamp01(xn))), g: gainAt(clamp01(yn)) }
            start()
        }

        // A finger dragging across the band steers it; vertical scrolling still works.
        function onTouch(e) {
            if (e.pointerType !== "touch") return
            var r = root.getBoundingClientRect()
            var xn = graphX(e.clientX)
            var yn = (e.clientY - r.top) / r.height
            lastInput = performance.now()
            setReading(xn, yn)
            aim(xn, yn)
        }
        root.addEventListener("pointerdown", onTouch)
        root.addEventListener("pointermove", onTouch)

        measure()
        if ("ResizeObserver" in window) new ResizeObserver(measure).observe(root)
        window.addEventListener("resize", measure)
        window.addEventListener("scroll", function () {
            // The band's left edge never changes on scroll, but keep the box honest after layout shifts.
            if (Math.abs(root.getBoundingClientRect().left - railInset() - box.left) > 0.5) measure()
        }, { passive: true })
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure)

        if ("IntersectionObserver" in window) {
            new IntersectionObserver(function (entries) {
                inView = entries[entries.length - 1].isIntersecting
                if (inView) start()
            }).observe(root)
        } else {
            inView = true
            start()
        }

        return {
            mouse: function (xn, yn) {
                mouseSeen = true
                aim(xn, yn)
            },
        }
    })()

    /* ---------- Pointer: one reading for everything ---------- */

    window.addEventListener(
        "pointermove",
        function (e) {
            if (e.pointerType === "touch") return
            var xn = graphX(e.clientX)
            var yn = e.clientY / window.innerHeight
            setReading(xn, yn)
            if (floor) floor.mouse(xn, yn)
        },
        { passive: true }
    )

    commitReading()

    /* ---------- Measure cursor (mouse only) ---------- */

    var cursor = document.getElementById("cursor")
    if (cursor && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
        document.documentElement.classList.add("has-measure-cursor")
        var cx = 0
        var cy = 0
        var cursorFrame = 0
        var place = function () {
            cursorFrame = 0
            cursor.style.transform = "translate3d(" + cx + "px," + cy + "px,0)"
        }
        var overLink = function (el) {
            return !!(el && el.closest && el.closest("[data-cursor='link']"))
        }
        window.addEventListener(
            "pointermove",
            function (e) {
                if (e.pointerType === "touch") return
                cx = e.clientX
                cy = e.clientY
                cursor.classList.add("is-on")
                cursor.classList.toggle("is-link", overLink(e.target))
                if (!cursorFrame) cursorFrame = window.requestAnimationFrame(place)
            },
            { passive: true }
        )
        window.addEventListener("pointerdown", function (e) {
            if (e.pointerType !== "touch") cursor.classList.add("is-pressed")
        })
        window.addEventListener("pointerup", function () {
            cursor.classList.remove("is-pressed")
        })
        document.documentElement.addEventListener("mouseleave", function () {
            cursor.classList.remove("is-on")
        })
        window.addEventListener("blur", function () {
            cursor.classList.remove("is-on", "is-pressed")
        })
    }

    /* ---------- Rail index: underline the section on screen ---------- */

    var links = document.querySelectorAll(".rail-index a[href^='#']")
    if (links.length && "IntersectionObserver" in window) {
        var onScreen = {}
        var spy = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (en) {
                    onScreen[en.target.id] = en.isIntersecting
                })
                var current = null
                for (var i = 0; i < links.length; i++) {
                    var id = links[i].getAttribute("href").slice(1)
                    if (onScreen[id]) current = id
                }
                for (i = 0; i < links.length; i++) {
                    links[i].classList.toggle("is-current", links[i].getAttribute("href").slice(1) === current)
                }
            },
            { rootMargin: "-50% 0px -50% 0px" }
        )
        for (var i = 0; i < links.length; i++) {
            var section = document.getElementById(links[i].getAttribute("href").slice(1))
            if (section) spy.observe(section)
        }
    }
})()
