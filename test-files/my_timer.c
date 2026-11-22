#include "my_timer.h"
#include "cms8s6990.h"
#include "timer.h"

static volatile unsigned long xdata system_tick_100us;

void MyTimer_Init(void) {
	system_tick_100us = 0UL;
	TMR_Stop(TMR3);
	TMR_ConfigRunMode(TMR3, TMR_MODE_TIMING, TMR_TIM_16BIT);
	TMR_ConfigTimerClk(TMR3, TMR_CLK_DIV_4);
	TMR3_SET_PERIOD(MY_TIMER_T3_RELOAD_HIGH, MY_TIMER_T3_RELOAD_LOW);
	EIE2 |= 0x01U;
	IE |= 0x80U;
	TMR_Start(TMR3);
}

void MyTimer_TickISR(void) {
	TMR3_SET_PERIOD(MY_TIMER_T3_RELOAD_HIGH, MY_TIMER_T3_RELOAD_LOW);
	system_tick_100us++;
}

unsigned long MyTimer_GetTick100us(void) {
	unsigned char interrupt_state;
	unsigned long tick;

	interrupt_state = (unsigned char)(IE & 0x80U);
	IE &= (unsigned char)~0x80U;
	tick = system_tick_100us;
	if (interrupt_state != 0U) {
		IE |= 0x80U;
	}
	return tick;
}

void MyTimer_Start(MySoftwareTimer *timer, unsigned long duration_ticks) {
	if (timer == 0) {
		return;
	}
	timer->started_at_ticks = MyTimer_GetTick100us();
	timer->duration_ticks = duration_ticks;
	timer->active = 1U;
}

void MyTimer_Stop(MySoftwareTimer *timer) {
	if (timer != 0) {
		timer->active = 0U;
	}
}

unsigned char MyTimer_Expired(MySoftwareTimer *timer) {
	if (timer == 0 || timer->active == 0U) {
		return 0U;
	}
	if ((unsigned long)(MyTimer_GetTick100us() - timer->started_at_ticks) >= timer->duration_ticks) {
		timer->active = 0U;
		return 1U;
	}
	return 0U;
}