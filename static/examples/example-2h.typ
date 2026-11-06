// Example: a double lesson (2 x 45 min, 10 min break) with a 20 % buffer.
// Each hour: 9 min buffer, 36 min planned. Hour 2 here is exercises: Moodle quizzes solved together.
// Compiles next to unified-preamble.typ; in your notes, the import is already at the top.

#import "unified-preamble.typ": *

#let lesson = (
  date: "2026.11.11",
  institution: "ETH",
  class: "Physics I",
  topic: "RC circuits",
  start: "10:15",
  hour-length: 45,
  break-length: 10,
  buffer: 20,

  hour1: (
    (6, [Intro], (
      (1, [Welcome]),
      (2, [Questions, infos]),
      (3, [Activators]),
    )),
    (10, [Current and resistance], (
      (3, [$I = n q v_d A$]),
      (3, [Quiz 1]),
      (4, [$Delta V = I R$, $R = rho L\/A$]),
    )),
    (8, [Power], (
      (5, [Equation chain $P = I Delta V$]),
      (3, [Quiz 2]),
    )),
    (12, [RC circuits], (
      (4, [Loop equation]),
      (4, [Charging]),
      (4, [Discharging]),
    )),
  ),

  hour2: (
    (24, [Moodle quizzes 8.1 to 8.4], (
      (6, [8.1 alone, then together]),
      (6, [8.2]),
      (6, [8.3]),
      (6, [8.4]),
    )),
    (8, [Moodle quiz 8.5], (
      (8, [8.5: steady state of the capacitor]),
    )),
    (4, [Activators Post], (
      (4, [Activators again, with reasons]),
    )),
  ),
)

#timetable(lesson)
