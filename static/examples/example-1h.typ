// Example: a one-hour lesson with a 20 % buffer.
// 45 min - 9 min buffer = 36 min planned; Chrono stretches them over the 45 min.
// Compiles next to unified-preamble.typ; in your notes, the import is already at the top.

#import "unified-preamble.typ": *

#let lesson = (
  date: "2026.11.10",
  institution: "ETH",
  class: "Physics I",
  topic: "Kirchhoff's rules",
  start: "08:15",
  hour-length: 45,
  buffer: 20,

  hour1: (
    (5, [Intro], (
      (2, [Welcome, today's goal]),
      (3, [Activators (abstimmbar)]),
    )),
    (12, [Kirchhoff's rules], (
      (4, [Loop rule: where it comes from]),
      (4, [Node rule: charge conservation]),
      (4, [Quiz 1]),
    )),
    (12, [Series and parallel], (
      (6, [Equation chain: $R_"eq"$ in series]),
      (6, [Parallel, together on the board]),
    )),
    (7, [Wrap-up], (
      (4, [Activators again, with reasons]),
      (3, [Summary, exercise sheet]),
    )),
  ),
)

#timetable(lesson)
