import React, { useState, useRef, useEffect } from 'react';
import { Calendar, X, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';

interface DateRangeFilterProps {
  dateFrom?: Date;
  dateTo?: Date;
  onDateRangeChange: (from: Date | undefined, to: Date | undefined) => void;
}

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];
const DAYS_HEADER = ['lu', 'ma', 'mi', 'ju', 'vi', 'sa', 'do'];

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isInRange(day: Date, from?: Date, to?: Date) {
  if (!from || !to) return false;
  return day > from && day < to;
}

export default function DateRangeFilter({
  dateFrom,
  dateTo,
  onDateRangeChange,
}: DateRangeFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = dateFrom || new Date();
    return d.getMonth();
  });
  const [viewYear, setViewYear] = useState(() => {
    const d = dateFrom || new Date();
    return d.getFullYear();
  });
  const [showMonthDropdown, setShowMonthDropdown] = useState(false);
  const [showYearDropdown, setShowYearDropdown] = useState(false);
  // Track whether we're selecting start or end
  const [selecting, setSelecting] = useState<'from' | 'to'>('from');
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const monthDropdownRef = useRef<HTMLDivElement>(null);
  const yearDropdownRef = useRef<HTMLDivElement>(null);

  const hasFilter = dateFrom || dateTo;

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowMonthDropdown(false);
        setShowYearDropdown(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Calculate fixed dropdown position anchored to viewport (avoids overflow on mobile)
  useEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const DROPDOWN_WIDTH = 320;
    const MARGIN = 8;

    let left = rect.right - DROPDOWN_WIDTH;
    if (left < MARGIN) left = MARGIN;
    const maxLeft = window.innerWidth - DROPDOWN_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;

    setDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 8,
      left,
      width: Math.min(DROPDOWN_WIDTH, window.innerWidth - MARGIN * 2),
    });
  }, [isOpen]);

  // Navigate to dateFrom month when opening
  useEffect(() => {
    if (isOpen && dateFrom) {
      setViewMonth(dateFrom.getMonth());
      setViewYear(dateFrom.getFullYear());
    } else if (isOpen && !dateFrom) {
      const now = new Date();
      setViewMonth(now.getMonth());
      setViewYear(now.getFullYear());
    }
  }, [isOpen]);

  const formatDateShort = (d: Date) =>
    d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const chipLabel = hasFilter
    ? `${dateFrom ? formatDateShort(dateFrom) : '...'} – ${dateTo ? formatDateShort(dateTo) : '...'}`
    : 'Fechas';

  // Build calendar grid
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const lastOfMonth = new Date(viewYear, viewMonth + 1, 0);

  // Monday-based week: Monday = 0
  let startDay = firstOfMonth.getDay() - 1;
  if (startDay < 0) startDay = 6;

  const totalDays = lastOfMonth.getDate();
  const weeks: (Date | null)[][] = [];
  let currentWeek: (Date | null)[] = [];

  // Leading empty cells
  for (let i = 0; i < startDay; i++) {
    currentWeek.push(null);
  }

  for (let day = 1; day <= totalDays; day++) {
    currentWeek.push(new Date(viewYear, viewMonth, day));
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  // Trailing empty cells
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push(null);
    }
    weeks.push(currentWeek);
  }

  const handleDayClick = (day: Date) => {
    if (selecting === 'from') {
      // Starting a new selection
      onDateRangeChange(day, undefined);
      setSelecting('to');
    } else {
      // Selecting end date
      if (dateFrom && day < dateFrom) {
        // If clicked before start, restart selection
        onDateRangeChange(day, undefined);
        setSelecting('to');
      } else {
        onDateRangeChange(dateFrom, day);
        setSelecting('from');
      }
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDateRangeChange(undefined, undefined);
    setSelecting('from');
    setIsOpen(false);
  };

  const handleClearInCalendar = () => {
    onDateRangeChange(undefined, undefined);
    setSelecting('from');
  };

  const goToPrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const goToNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const today = new Date();

  // Year range for dropdown
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - 10; y <= currentYear + 2; y++) {
    years.push(y);
  }

  const getDayClasses = (day: Date) => {
    const isStart = dateFrom && isSameDay(day, dateFrom);
    const isEnd = dateTo && isSameDay(day, dateTo);
    const inRange = isInRange(day, dateFrom, dateTo);
    const isToday = isSameDay(day, today);

    let base = 'w-9 h-9 flex items-center justify-center text-sm cursor-pointer transition-all duration-150 ';

    if (isStart || isEnd) {
      base += 'bg-lavanda text-white rounded-full font-semibold shadow-sm ';
    } else if (inRange) {
      base += 'bg-lavanda-claro bg-opacity-40 text-marfil ';
      // Round edges for range visual
      if (dateFrom && day.getTime() === dateFrom.getTime() + 86400000) {
        base += 'rounded-l-full ';
      }
    } else if (isToday) {
      base += 'text-lavanda font-semibold ';
    } else {
      base += 'text-marfil hover:bg-pizarra rounded-full ';
    }

    return base;
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
          hasFilter
            ? 'bg-lavanda-claro text-marfil shadow-md'
            : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda-claro hover:bg-opacity-30'
        }`}
      >
        <Calendar className="w-4 h-4" />
        <span>{chipLabel}</span>
        {hasFilter && (
          <span
            onClick={handleClear}
            className="ml-0.5 hover:bg-marfil hover:bg-opacity-20 rounded-full p-0.5 transition-colors"
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>

      {isOpen && (
        <div className="z-50 bg-tinta rounded-2xl shadow-xl border border-slate-200 p-5" style={dropdownStyle}>
          {/* Month/Year header with dropdowns */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1">
              {/* Month dropdown */}
              <div className="relative" ref={monthDropdownRef}>
                <button
                  onClick={() => { setShowMonthDropdown(!showMonthDropdown); setShowYearDropdown(false); }}
                  className="flex items-center gap-0.5 text-sm font-semibold text-marfil hover:text-lavanda transition-colors"
                >
                  {MONTHS[viewMonth]}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {showMonthDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-tinta rounded-lg shadow-lg border border-slate-200 py-1 z-10 max-h-48 overflow-y-auto">
                    {MONTHS.map((m, i) => (
                      <button
                        key={m}
                        onClick={() => { setViewMonth(i); setShowMonthDropdown(false); }}
                        className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-pizarra transition-colors ${
                          i === viewMonth ? 'text-lavanda font-semibold' : 'text-marfil'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Year dropdown */}
              <div className="relative" ref={yearDropdownRef}>
                <button
                  onClick={() => { setShowYearDropdown(!showYearDropdown); setShowMonthDropdown(false); }}
                  className="flex items-center gap-0.5 text-sm font-semibold text-marfil hover:text-lavanda transition-colors"
                >
                  {viewYear}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {showYearDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-tinta rounded-lg shadow-lg border border-slate-200 py-1 z-10 max-h-48 overflow-y-auto">
                    {years.map(y => (
                      <button
                        key={y}
                        onClick={() => { setViewYear(y); setShowYearDropdown(false); }}
                        className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-pizarra transition-colors ${
                          y === viewYear ? 'text-lavanda font-semibold' : 'text-marfil'
                        }`}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Navigation arrows */}
            <div className="flex items-center gap-1">
              <button
                onClick={goToPrevMonth}
                className="p-1 rounded-full hover:bg-pizarra text-lavanda-archivo hover:text-marfil transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={goToNextMonth}
                className="p-1 rounded-full hover:bg-pizarra text-lavanda-archivo hover:text-marfil transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Days header */}
          <div className="grid grid-cols-7 mb-2">
            {DAYS_HEADER.map(d => (
              <div key={d} className="w-9 h-7 flex items-center justify-center text-xs font-medium text-lavanda-archivo">
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="space-y-0.5">
            {weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7">
                {week.map((day, di) => (
                  <div key={di} className="flex items-center justify-center">
                    {day ? (
                      <button
                        onClick={() => handleDayClick(day)}
                        className={getDayClasses(day)}
                      >
                        {day.getDate()}
                      </button>
                    ) : (
                      <div className="w-9 h-9" />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Clear button */}
          {hasFilter && (
            <div className="flex justify-center pt-3 mt-3 border-t border-slate-100">
              <button
                onClick={handleClearInCalendar}
                className="text-sm text-lavanda-archivo hover:text-lavanda transition-colors font-medium"
              >
                Limpiar fechas
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
