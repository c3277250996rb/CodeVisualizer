#ifndef MY_TIMER_H
#define MY_TIMER_H

#define MY_TIMER_TICK_PERIOD_US 100U
#define MY_TIMER_T3_COUNTS_PER_TICK 600U
#define MY_TIMER_T3_RELOAD_HIGH 0xFDU
#define MY_TIMER_T3_RELOAD_LOW 0xA8U

/* Timer3 uses Fsys/4 = 6 MHz at 24 MHz; 600 counts generate one 100us tick. */
/* Initialize once before other timed modules. ISR only publishes ticks; APIs are foreground-only. */
/* Software-timer durations and elapsed values use 100us ticks; expiration is one-shot. */
typedef struct {
	unsigned long started_at_ticks;
	unsigned long duration_ticks;
	unsigned char active;
} MySoftwareTimer;

void MyTimer_Init(void);
void MyTimer_TickISR(void);
unsigned long MyTimer_GetTick100us(void);
void MyTimer_Start(MySoftwareTimer *timer, unsigned long duration_ticks);
void MyTimer_Stop(MySoftwareTimer *timer);
unsigned char MyTimer_Expired(MySoftwareTimer *timer);

#endif